"""校园位置的朴素贝叶斯观测模型，使用 pgmpy 做精确推理。

给定同一时刻的位置 L，去重后的各 origin 被假定条件独立。这是建模假设，
并不保证现实中不同来源独立；转述同一 origin 的记录只计一次。支持集 A
表示似然报告，而非 BPA 或已含先验的后验：
P(report=yes | L) = r / |A| * I[L in A] + (1-r) / |frame|。
其补事件为 1-P(report=yes | L)，故每个二元观测通道均可归一。

r = reliability * exp(-age/tau)。默认 tau=300 是设计值，未经实测校准；
tau 与 observed_at、now 使用相同的时钟单位，按秒计时时即为 300 秒。
模型没有位置转移或真值入口，较老观测只通过可靠度折扣影响当前位置。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import exp, fsum, isclose, isfinite, log
from numbers import Real
from types import MappingProxyType

from pgmpy.factors.discrete import TabularCPD
from pgmpy.inference import VariableElimination
from pgmpy.models import DiscreteBayesianNetwork

from .evidence import Evidence, deduplicate_evidence

__all__ = ["BayesResult", "LocationBayes", "ZeroLikelihoodError"]

_LOCATION = "location"
_DEFAULT_TAU = 300.0


@dataclass(frozen=True)
class BayesResult:
    """概率按输入 frame 顺序排列；trace 仅包含当前可见的证据信息。"""

    probabilities: dict[str, float]
    selected_evidence_ids: tuple[str, ...]
    trace: dict[str, object]


class ZeroLikelihoodError(ValueError):
    """所有先验可能状态的联合似然均为零，条件后验无定义。"""

    def __init__(self, selected_evidence_ids: tuple[str, ...]) -> None:
        super().__init__("证据在先验支持上具有零总似然，无法定义贝叶斯后验")
        self.selected_evidence_ids = selected_evidence_ids


def _finite(value: Real, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{label} 必须是有限数值")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{label} 必须是有限数值")
    return result


class LocationBayes:
    """在固定有限位置框架上融合独立的 simple-support 似然报告。

    未提供先验时使用均匀先验；显式先验必须覆盖整个框架、非负且总和为 1。
    infer 每次从原始先验重新计算，不把前次结果当作隐式证据重复累计。
    缺失报告、全框架支持和零有效可靠度不提供位置信息。完全冲突或报告
    只支持先验概率为零的状态时抛出 ZeroLikelihoodError，不静默回退。
    """

    def __init__(
        self,
        frame: Sequence[str],
        prior: Mapping[str, float] | None = None,
        *,
        tau: float = _DEFAULT_TAU,
    ) -> None:
        if isinstance(frame, str) or not isinstance(frame, Sequence):
            raise TypeError("frame 必须是位置名称序列")
        states = tuple(frame)
        if not states or any(not isinstance(state, str) or not state.strip() for state in states):
            raise ValueError("frame 必须包含非空的位置名称")
        if len(set(states)) != len(states):
            raise ValueError("frame 不得包含重复位置")
        decay = _finite(tau, "tau")
        if decay <= 0.0:
            raise ValueError("tau 必须大于 0")
        if prior is None:
            probabilities = dict.fromkeys(states, 1.0 / len(states))
        else:
            if not isinstance(prior, Mapping):
                raise TypeError("prior 必须是位置到概率的映射")
            if set(prior) != set(states):
                raise ValueError("prior 必须且只能覆盖 frame 中的位置")
            probabilities = {state: _finite(prior[state], "先验概率") for state in states}
            if any(value < 0.0 or value > 1.0 for value in probabilities.values()):
                raise ValueError("先验概率必须位于 [0, 1]")
            total = fsum(probabilities.values())
            if not isclose(total, 1.0, rel_tol=0.0, abs_tol=1e-12):
                raise ValueError("先验概率之和必须为 1")
            probabilities = {state: value / total for state, value in probabilities.items()}
        self.frame = states
        self.prior: Mapping[str, float] = MappingProxyType(probabilities)
        self.tau = decay

    def infer(self, evidence: Sequence[Evidence], now: float) -> BayesResult:
        """仅使用已接收且已观测的证据；按 origin 最早接收元数据去重。

        独立报告的似然因子先在对数域相乘，再统一缩放为 virtual evidence。
        缩放常数在条件化时抵消；此处不乘先验、不把 BPA 转作后验。
        先验条件化与边缘概率计算交给 pgmpy VariableElimination。
        """
        clock = _finite(now, "now")
        records = tuple(evidence)
        if any(not isinstance(item, Evidence) for item in records):
            raise TypeError("evidence 必须由 Evidence 组成")
        # 不可见载荷在验证和去重之前剔除，不能借助未来记录改变当前选择。
        visible = tuple(
            item for item in records if item.received_at <= clock and item.observed_at <= clock
        )
        theta = frozenset(self.frame)
        if any(item.support is not None and not item.support <= theta for item in visible):
            raise ValueError("证据支持必须是 frame 的子集")
        selected, discarded = deduplicate_evidence(visible)
        selected_ids = tuple(item.evidence_id for item in selected)
        trace: dict[str, object] = {
            "engine": "pgmpy.VariableElimination",
            "model": "conditionally_independent_simple_support_channels",
            "now": clock,
            "tau": self.tau,
            "tau_is_design_parameter": True,
            "selected_evidence_ids": selected_ids,
            "discarded_evidence_ids": tuple(item.evidence_id for item in discarded),
            "observations": [],
        }
        observations: list[dict[str, object]] = []
        log_terms: dict[str, list[float]] = {state: [] for state in self.frame}
        state_possible = dict.fromkeys(self.frame, True)
        informative = False
        for item in selected:
            age = clock - item.observed_at
            reliability = item.reliability * exp(-age / self.tau)
            support = item.support
            reason = (
                "missing"
                if support is None
                else "vacuous"
                if support == theta
                else "zero_reliability"
                if reliability == 0.0
                else "used"
            )
            likelihood = (
                dict.fromkeys(self.frame, 1.0)
                if support is None
                else {
                    state: (reliability / len(support) if state in support else 0.0)
                    + (1.0 - reliability) / len(self.frame)
                    for state in self.frame
                }
            )
            observations.append(
                {
                    "evidence_id": item.evidence_id,
                    "source_id": item.source_id,
                    "origin_id": item.origin_id,
                    "support": None if support is None else sorted(support),
                    "observed_at": item.observed_at,
                    "received_at": item.received_at,
                    "age": age,
                    "effective_reliability": reliability,
                    "likelihood": likelihood,
                    "status": reason,
                }
            )
            if reason != "used":
                continue
            informative = True
            for state, value in likelihood.items():
                if value == 0.0:
                    state_possible[state] = False
                else:
                    log_terms[state].append(log(value))
        trace["observations"] = observations
        if not informative:
            trace["status"] = "prior"
            return BayesResult(dict(self.prior), selected_ids, trace)

        possible = [
            state for state in self.frame if state_possible[state] and self.prior[state] > 0.0
        ]
        if not possible:
            raise ZeroLikelihoodError(selected_ids)
        log_likelihood = {state: fsum(log_terms[state]) for state in possible}
        offset = max(log_likelihood.values())
        # 只保留先验支持上的似然，确保至少一个正先验状态的缩放似然为 1。
        weights = {
            state: exp(log_likelihood[state] - offset) if state in log_likelihood else 0.0
            for state in self.frame
        }
        model = DiscreteBayesianNetwork()
        model.add_node(_LOCATION)
        model.add_cpds(
            TabularCPD(
                _LOCATION,
                len(self.frame),
                [[self.prior[state]] for state in self.frame],
                state_names={_LOCATION: list(self.frame)},
            )
        )
        # virtual_evidence 的列是似然而非根节点概率；pgmpy 将它转换为
        # 二元子节点的 [weights, 1-weights]，每个条件列严格归一。
        virtual = TabularCPD(
            _LOCATION,
            len(self.frame),
            [[weights[state]] for state in self.frame],
            state_names={_LOCATION: list(self.frame)},
        )
        posterior = VariableElimination(model).query(
            [_LOCATION], virtual_evidence=[virtual], show_progress=False
        )
        probabilities = {
            state: float(posterior.get_value(**{_LOCATION: state})) for state in self.frame
        }
        if any(not isfinite(value) or value < 0.0 for value in probabilities.values()):
            raise ArithmeticError("pgmpy 返回了非法后验概率")
        normalizer = fsum(probabilities.values())
        if normalizer <= 0.0:
            raise ArithmeticError("pgmpy 返回了无法归一的后验概率")
        probabilities = {state: value / normalizer for state, value in probabilities.items()}
        trace["status"] = "conditioned"
        trace["virtual_likelihood"] = weights
        return BayesResult(probabilities, selected_ids, trace)
