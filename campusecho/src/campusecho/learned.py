"""仅用训练轨迹估计的 11 节点校园位置贝叶斯网络。

time_of_day、weather 是 location 的父节点；每个来源的 age 是独立根，
report 的父节点为 location、age。报告 CPD 使用 Dirichlet 平滑；集合
报告在训练时作均匀分数计数，在推理时作为同一类别变量的集合事件。
这些是公开建模假设，不把 BPA 或别的模型后验当训练标签。
"""

from __future__ import annotations

import hashlib
import json
from bisect import bisect_right
from collections import OrderedDict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import fsum, isfinite
from numbers import Real
from pathlib import Path
from threading import Lock

import numpy as np
from pgmpy.factors.discrete import TabularCPD
from pgmpy.inference import VariableElimination
from pgmpy.models import DiscreteBayesianNetwork

from .bayes import BayesResult
from .data import SOURCES, TIME_OF_DAY, WEATHER, DatasetCase
from .evidence import Evidence, deduplicate_evidence
from .world import FRAME

MISSING_REPORT = "__missing__"
MODEL_SCHEMA_VERSION = 1
_LOCATION = "location"


def _finite(value: Real, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{name} 必须是有限数值")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} 必须是有限数值")
    return result


@dataclass(frozen=True)
class PreparedEvidence:
    selected: tuple[Evidence, ...]
    discarded: tuple[Evidence, ...]


def prepare_evidence(
    evidence: Iterable[Evidence], now: float, *, frame: Iterable[str] = FRAME
) -> PreparedEvidence:
    """共享强基线预处理；输入必须已经按待查询的目标角色筛选。

    先过滤未来消息，再按 origin 保留最早接收记录，最后每来源只取最新
    observed_at。平局按 received_at、evidence_id；不按内容或真值择优。
    """
    clock = _finite(now, "now")
    records = tuple(evidence)
    if any(not isinstance(item, Evidence) for item in records):
        raise TypeError("evidence 必须由 Evidence 组成")
    visible = tuple(
        item for item in records if item.received_at <= clock and item.observed_at <= clock
    )
    theta = frozenset(frame)
    if any(item.support is not None and not item.support <= theta for item in visible):
        raise ValueError("证据支持必须是 frame 的子集")
    unique, copies = deduplicate_evidence(visible)
    groups: dict[str, list[Evidence]] = {}
    for item in unique:
        groups.setdefault(item.source_id, []).append(item)
    selected = []
    discarded = list(copies)
    for source in sorted(groups):
        ordered = sorted(
            groups[source], key=lambda item: (-item.observed_at, item.received_at, item.evidence_id)
        )
        selected.append(ordered[0])
        discarded.extend(ordered[1:])
    return PreparedEvidence(
        tuple(selected), tuple(sorted(discarded, key=lambda item: item.evidence_id))
    )


def _context(context: Mapping[str, str] | None) -> dict[str, str]:
    if context is None:
        return {}
    if not isinstance(context, Mapping):
        raise TypeError("context 必须是映射或 None")
    if set(context) - {"time_of_day", "weather"}:
        raise ValueError("context 只能包含 time_of_day/weather")
    result = dict(context)
    if "time_of_day" in result and result["time_of_day"] not in TIME_OF_DAY:
        raise ValueError("未知 time_of_day")
    if "weather" in result and result["weather"] not in WEATHER:
        raise ValueError("未知 weather")
    return result


def _normalize(values: np.ndarray) -> np.ndarray:
    return values / values.sum(axis=0, keepdims=True)


class LearnedLocationModel:
    """显式训练/推理边界；infer 没有 DatasetCase、truth 或 world 入口。

    report_distribution 返回 frame 内每个位置及 __missing__ 的概率。
    __missing__ 用于行动的无回复分支；infer 中 support=None 始终表示
    未观察到报告节点，进行边缘化。直接消息也存在误报、延迟及缺失。
    """

    def __init__(self, parameters: Mapping[str, object]) -> None:
        # 通过 JSON 深拷贝，避免调用方持有嵌套数组后修改已验证模型。
        self._parameters = json.loads(json.dumps(parameters, allow_nan=False))
        values = self._parameters
        if values.get("schema_version") != MODEL_SCHEMA_VERSION:
            raise ValueError("不支持的模型 schema_version")
        self.frame = tuple(values["frame"])
        self.sources = tuple(values["sources"])
        self.age_bins = tuple(float(value) for value in values["age_bins"])
        self.alpha = _finite(values["alpha"], "alpha")
        if self.alpha <= 0:
            raise ValueError("alpha 必须大于零，以保证冲突下正似然")
        if not self.frame or len(set(self.frame)) != len(self.frame):
            raise ValueError("frame 必须非空且不重复")
        if any(not isinstance(state, str) or not state for state in self.frame):
            raise ValueError("frame 状态必须是非空字符串")
        if MISSING_REPORT in self.frame:
            raise ValueError("frame 使用了保留的缺失状态")
        if not self.sources or len(set(self.sources)) != len(self.sources):
            raise ValueError("sources 必须非空且不重复")
        if any(not isinstance(source, str) or not source for source in self.sources):
            raise ValueError("source 必须为非空字符串")
        if any(not isfinite(value) or value <= 0 for value in self.age_bins):
            raise ValueError("age_bins 必须是有限正数")
        if tuple(sorted(set(self.age_bins))) != self.age_bins:
            raise ValueError("age_bins 必须严格递增")
        self.age_labels = tuple(f"age_{index}" for index in range(len(self.age_bins) + 1))
        self.report_states = (*self.frame, MISSING_REPORT)
        self.training_id = str(values["training"]["training_id"])
        self.network = self._build_network()
        self._inference = VariableElimination(self.network)
        self._posterior_cache: OrderedDict[tuple, tuple[float, ...]] = OrderedDict()
        self._posterior_cache_lock = Lock()

    @classmethod
    def fit(
        cls,
        train_cases: Iterable[DatasetCase],
        *,
        alpha: float = 1.0,
        age_bins: Sequence[float] = (5.0, 15.0),
        frame: Sequence[str] = tuple(sorted(FRAME)),
        sources: Sequence[str] = SOURCES,
    ) -> LearnedLocationModel:
        """只接受 split=train；参数平滑强度及 age_bins 的选择应由外部 val 完成。"""
        smoothing = _finite(alpha, "alpha")
        if smoothing <= 0:
            raise ValueError("alpha 必须大于零")
        states, channels = tuple(frame), tuple(sources)
        bins = tuple(_finite(value, "age_bin") for value in age_bins)
        if not states or len(set(states)) != len(states) or MISSING_REPORT in states:
            raise ValueError("frame 必须非空、不重复且不含保留状态")
        if not channels or len(set(channels)) != len(channels):
            raise ValueError("sources 必须非空且不重复")
        if any(value <= 0 for value in bins) or tuple(sorted(set(bins))) != bins:
            raise ValueError("age_bins 必须是严格递增的正数")
        k, a = len(states), len(bins) + 1
        time_counts = np.full(len(TIME_OF_DAY), smoothing)
        weather_counts = np.full(len(WEATHER), smoothing)
        location_counts = np.full((k, len(TIME_OF_DAY), len(WEATHER)), smoothing)
        report_counts = {source: np.full((k + 1, k, a), smoothing) for source in channels}
        age_counts = {source: np.full(a, smoothing) for source in channels}
        totals = {source: np.zeros(a) for source in channels}
        correct = {source: np.zeros(a) for source in channels}
        missing = {source: np.zeros(a) for source in channels}
        state_index = {state: index for index, state in enumerate(states)}
        digest = hashlib.sha256()
        episodes: set[str] = set()
        seen: set[str] = set()
        count = 0
        for case in train_cases:
            # 在读 truth 之前验证分割；误把验证/测试集传入时不触碰标签。
            if case.split != "train":
                raise ValueError("fit 只能使用 train，val/test 标签禁止进入参数学习")
            if case.case_id in seen:
                raise ValueError("训练 case_id 重复")
            seen.add(case.case_id)
            if case.truth not in state_index:
                raise ValueError("训练 truth 超出 frame")
            context = _context(case.context)
            if set(context) != {"time_of_day", "weather"}:
                raise ValueError("训练样本必须提供完整上下文")
            t = TIME_OF_DAY.index(context["time_of_day"])
            w = WEATHER.index(context["weather"])
            location = state_index[case.truth]
            time_counts[t] += 1
            weather_counts[w] += 1
            location_counts[location, t, w] += 1
            prepared = prepare_evidence(case.evidence, case.now, frame=states)
            for item in prepared.selected:
                source = item.source_id
                if source not in report_counts:
                    continue
                age = bisect_right(bins, case.now - item.observed_at)
                age_counts[source][age] += 1
                if item.support is None:
                    report_counts[source][k, location, age] += 1
                    missing[source][age] += 1
                elif item.support != frozenset(states) and item.reliability > 0:
                    fraction = 1 / len(item.support)
                    for report in item.support:
                        report_counts[source][state_index[report], location, age] += fraction
                    totals[source][age] += 1
                    if case.truth in item.support:
                        correct[source][age] += fraction
            digest.update(json.dumps(case.to_dict(), sort_keys=True).encode("utf-8"))
            episodes.add(case.episode_id)
            count += 1
        if count == 0:
            raise ValueError("训练集不能为空")
        # 无回复率只依赖来源和年龄，不依赖位置。绑定各位置的缺失列，
        # 保证行动策略中的 no-reply 分支确实不改变位置后验。
        learned_reports = {}
        for source in channels:
            reply_probability = (totals[source] + smoothing) / (
                totals[source] + missing[source] + 2 * smoothing
            )
            replied = _normalize(report_counts[source][:k])
            learned_reports[source] = np.concatenate(
                (
                    replied * reply_probability[np.newaxis, np.newaxis, :],
                    np.broadcast_to((1 - reply_probability)[np.newaxis, np.newaxis, :], (1, k, a)),
                ),
                axis=0,
            )
        calibration = {
            source: {
                "reliability": (
                    (correct[source] + smoothing) / (totals[source] + 2 * smoothing)
                ).tolist(),
                "nonmissing_counts": totals[source].tolist(),
                "correct_fractional_counts": correct[source].tolist(),
                "missing_counts": missing[source].tolist(),
                "reply_probability": (
                    (totals[source] + smoothing)
                    / (totals[source] + missing[source] + 2 * smoothing)
                ).tolist(),
            }
            for source in channels
        }
        return cls(
            {
                "schema_version": MODEL_SCHEMA_VERSION,
                "frame": list(states),
                "sources": list(channels),
                "age_bins": list(bins),
                "alpha": smoothing,
                "time_prior": _normalize(time_counts).tolist(),
                "weather_prior": _normalize(weather_counts).tolist(),
                "location_cpd": _normalize(location_counts).tolist(),
                "age_priors": {
                    source: _normalize(age_counts[source]).tolist() for source in channels
                },
                "report_cpds": {source: learned_reports[source].tolist() for source in channels},
                "calibration": calibration,
                "training": {
                    "training_id": "train-sha256:" + digest.hexdigest(),
                    "cases": count,
                    "episodes": len(episodes),
                    "split": "train",
                    "episode_ids_sha256": hashlib.sha256(
                        "\n".join(sorted(episodes)).encode()
                    ).hexdigest(),
                    "estimator": "Dirichlet-smoothed categorical counts; uniform fractional set reports",
                    "reliability_estimator": "Beta(alpha,alpha) smoothed fractional correctness by source/age",
                    "missing_policy": "Beta-smoothed reply rate by source/age, tied across location; missing input is marginalized",
                    "time_unit": "minute",
                },
            }
        )

    def _array(self, key: str, shape: tuple[int, ...], *, source: str | None = None) -> np.ndarray:
        raw = self._parameters[key] if source is None else self._parameters[key][source]
        value = np.asarray(raw, dtype=float)
        if value.shape != shape or not np.isfinite(value).all() or np.any(value <= 0):
            raise ValueError(f"{key} 必须是指定形状的严格正有限 CPD")
        if not np.allclose(value.sum(axis=0), 1, rtol=0, atol=1e-10):
            raise ValueError(f"{key} 的条件列之和必须为 1")
        return value

    def _build_network(self) -> DiscreteBayesianNetwork:
        k, a = len(self.frame), len(self.age_labels)
        network = DiscreteBayesianNetwork([("time_of_day", _LOCATION), ("weather", _LOCATION)])
        network.add_cpds(
            TabularCPD(
                "time_of_day",
                len(TIME_OF_DAY),
                self._array("time_prior", (len(TIME_OF_DAY),)).reshape(-1, 1),
                state_names={"time_of_day": list(TIME_OF_DAY)},
            ),
            TabularCPD(
                "weather",
                len(WEATHER),
                self._array("weather_prior", (len(WEATHER),)).reshape(-1, 1),
                state_names={"weather": list(WEATHER)},
            ),
            TabularCPD(
                _LOCATION,
                k,
                self._array("location_cpd", (k, len(TIME_OF_DAY), len(WEATHER))).reshape(k, -1),
                evidence=["time_of_day", "weather"],
                evidence_card=[len(TIME_OF_DAY), len(WEATHER)],
                state_names={
                    _LOCATION: list(self.frame),
                    "time_of_day": list(TIME_OF_DAY),
                    "weather": list(WEATHER),
                },
            ),
        )
        for source in self.sources:
            age, report = f"age:{source}", f"report:{source}"
            network.add_edges_from([(_LOCATION, report), (age, report)])
            network.add_cpds(
                TabularCPD(
                    age,
                    a,
                    self._array("age_priors", (a,), source=source).reshape(a, 1),
                    state_names={age: list(self.age_labels)},
                ),
                TabularCPD(
                    report,
                    k + 1,
                    self._array("report_cpds", (k + 1, k, a), source=source).reshape(k + 1, k * a),
                    evidence=[_LOCATION, age],
                    evidence_card=[k, a],
                    state_names={
                        report: list(self.report_states),
                        _LOCATION: list(self.frame),
                        age: list(self.age_labels),
                    },
                ),
            )
            calibration = self._parameters["calibration"][source]["reliability"]
            if len(calibration) != a or any(
                not isfinite(value) or not 0 <= value <= 1 for value in calibration
            ):
                raise ValueError("来源可靠度校准非法")
        if not network.check_model():
            raise ValueError("贝叶斯网络 CPD 校验失败")
        return network

    def _age_index(self, age: float) -> int:
        age = _finite(age, "age")
        if age < 0:
            raise ValueError("age 必须非负")
        return bisect_right(self.age_bins, age)

    def source_reliability(self, source: str, age: float = 0) -> float:
        """训练校准的分数正确率；未知来源报错，不凭测试标签回填。"""
        if source not in self.sources:
            raise ValueError(f"未知来源: {source}")
        return float(self._parameters["calibration"][source]["reliability"][self._age_index(age)])

    def report_distribution(
        self,
        location: str,
        source: str,
        age: float = 0,
        context: Mapping[str, str] | None = None,
    ) -> dict[str, float]:
        """P(report | location,source,age)，含 __missing__，返回防修改拷贝。

        无回复概率按 source/age 估计且跨位置相同。这里假设给定 location/age 后报告与 context 条件独立；context
        参数只作 schema 验证。location 必须是调用方的假设，不能取待测 truth。
        """
        _context(context)
        if location not in self.frame or source not in self.sources:
            raise ValueError("未知 location/source")
        index, age_index = self.frame.index(location), self._age_index(age)
        cpd = self._parameters["report_cpds"][source]
        return {
            state: float(cpd[row][index][age_index]) for row, state in enumerate(self.report_states)
        }

    def _posterior_for(
        self,
        observed_items: tuple[tuple[str, str], ...],
        set_reports: tuple[tuple[str, tuple[str, ...]], ...],
    ) -> tuple[float, ...]:
        """只缓存有限状态的 VE 概率，不缓存时间、证据 ID 或逐条 trace。"""
        key = (observed_items, set_reports)
        with self._posterior_cache_lock:
            cached = self._posterior_cache.get(key)
            if cached is not None:
                self._posterior_cache.move_to_end(key)
                return cached
        virtual = [
            TabularCPD(
                report,
                len(self.report_states),
                [[float(state in support)] for state in self.report_states],
                state_names={report: list(self.report_states)},
            )
            for report, support in set_reports
        ]
        # pgmpy 的 virtual_evidence 会扩展 inference.model；用独立副本隔离，
        # 避免上次集合观测残留，普通离散观测复用已校验的静态网络。
        inference = VariableElimination(self.network.copy()) if virtual else self._inference
        posterior = inference.query(
            [_LOCATION],
            evidence=dict(observed_items),
            virtual_evidence=virtual or None,
            show_progress=False,
        )
        probabilities = tuple(
            float(posterior.get_value(**{_LOCATION: state})) for state in self.frame
        )
        total = fsum(probabilities)
        if total <= 0 or any(not isfinite(value) or value < 0 for value in probabilities):
            raise ArithmeticError("pgmpy 返回了非法后验")
        result = tuple(value / total for value in probabilities)
        with self._posterior_cache_lock:
            self._posterior_cache[key] = result
            self._posterior_cache.move_to_end(key)
            if len(self._posterior_cache) > 8192:
                self._posterior_cache.popitem(last=False)
        return result

    def infer(
        self,
        evidence: Iterable[Evidence],
        now: float,
        context: Mapping[str, str] | None = None,
    ) -> BayesResult:
        clock = _finite(now, "now")
        observed = _context(context)
        prepared = prepare_evidence(evidence, clock, frame=self.frame)
        set_reports = []
        observations = []
        informative = []
        for item in prepared.selected:
            age = clock - item.observed_at
            reason = (
                "unknown_source"
                if item.source_id not in self.sources
                else "missing"
                if item.support is None
                else "vacuous"
                if item.support == frozenset(self.frame)
                else "zero_reliability"
                if item.reliability == 0
                else "used"
            )
            row: dict[str, object] = {
                "evidence_id": item.evidence_id,
                "source_id": item.source_id,
                "origin_id": item.origin_id,
                "observed_at": item.observed_at,
                "received_at": item.received_at,
                "age": age,
                "status": reason,
                "support": None if item.support is None else sorted(item.support),
            }
            if item.source_id in self.sources:
                row["age_bin"] = self.age_labels[self._age_index(age)]
                row["learned_reliability"] = self.source_reliability(item.source_id, age)
            observations.append(row)
            if reason != "used":
                continue
            source = item.source_id
            report = f"report:{source}"
            observed[f"age:{source}"] = self.age_labels[self._age_index(age)]
            if len(item.support) == 1:
                observed[report] = next(iter(item.support))
            else:
                # 集合报告是 report 属于该集合的事件；辅助子节点只承载指示似然。
                set_reports.append((report, tuple(sorted(item.support))))
            informative.append(item)
        values = self._posterior_for(tuple(sorted(observed.items())), tuple(sorted(set_reports)))
        probabilities = dict(zip(self.frame, values))
        selected_ids = tuple(item.evidence_id for item in prepared.selected)
        trace: dict[str, object] = {
            "engine": "pgmpy.VariableElimination",
            "model": "learned_context_age_report_bayesian_network",
            "training_id": self.training_id,
            "alpha": self.alpha,
            "age_bins": list(self.age_bins),
            "now": clock,
            "context": _context(context),
            "node_count": len(self.network.nodes()),
            "edges": [list(edge) for edge in self.network.edges()],
            "selected_evidence_ids": selected_ids,
            "discarded_evidence_ids": tuple(item.evidence_id for item in prepared.discarded),
            "observations": observations,
            "source_calibration": {
                source: list(self._parameters["calibration"][source]["reliability"])
                for source in self.sources
            },
            "status": "conditioned" if informative else "context_prior",
            "conflicting_reports": any(
                not left.support & right.support
                for index, left in enumerate(informative)
                for right in informative[index + 1 :]
            ),
            "conflict_policy": "strictly_positive_Dirichlet_CPDs; no hard contradictory assertions",
            "missing_policy": "unobserved_report_node_is_marginalized",
        }
        return BayesResult(probabilities, selected_ids, trace)

    def export_parameters(self) -> dict[str, object]:
        """返回完整 schema 的深拷贝，便于审计和独立枚举验证。"""
        return json.loads(json.dumps(self._parameters))

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(self._parameters, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: str | Path) -> LearnedLocationModel:
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))
