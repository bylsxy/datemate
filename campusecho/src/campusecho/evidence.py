"""有限辨识框架上的 BPA、批量证据融合和可追溯来源去重。

输入为闭世界 BPA；未归一合取结果单独保存空集质量。Yager 只在所有
来源完成合取之后转移一次冲突，避免逐对转移造成顺序依赖。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from math import fsum, isclose, isfinite
from numbers import Real
from types import MappingProxyType

Hypothesis = frozenset[str]
EMPTY: Hypothesis = frozenset()
_SUM_TOLERANCE = 1e-12


def _hypothesis(value: Iterable[str] | str) -> Hypothesis:
    if isinstance(value, str):
        value = (value,)
    result = frozenset(value)
    if any(not isinstance(state, str) or not state.strip() for state in result):
        raise ValueError("框架与假设的元素必须是非空字符串")
    return result


def _frame(value: Iterable[str]) -> Hypothesis:
    if isinstance(value, str):
        raise TypeError("frame 必须是状态集合，不能是单个字符串")
    result = _hypothesis(value)
    if not result:
        raise ValueError("辨识框架不能为空")
    return result


def _finite_number(value: Real, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{name} 必须是有限数值")
    number = float(value)
    if not isfinite(number):
        raise ValueError(f"{name} 必须是有限数值")
    return number


def _unit_interval(value: Real, name: str) -> float:
    number = _finite_number(value, name)
    if not 0.0 <= number <= 1.0:
        raise ValueError(f"{name} 必须位于 [0, 1]")
    return number


def _validated_masses(
    frame: Hypothesis, masses: Mapping[Hypothesis, float], *, allow_empty: bool
) -> Mapping[Hypothesis, float]:
    if not isinstance(masses, Mapping):
        raise TypeError("masses 必须是从假设集合到质量的映射")
    result: dict[Hypothesis, float] = {}
    for focal, value in masses.items():
        if not isinstance(focal, frozenset):
            raise TypeError("masses 的键必须是 frozenset[str]")
        focal = _hypothesis(focal)
        if not focal <= frame:
            raise ValueError("焦元必须是辨识框架的子集")
        mass = _unit_interval(value, "质量")
        if not focal and mass > 0.0 and not allow_empty:
            raise ValueError("闭世界 BPA 的空集质量必须为 0")
        if mass > 0.0:
            result[focal] = mass
    total = fsum(result.values())
    if not isclose(total, 1.0, rel_tol=0.0, abs_tol=_SUM_TOLERANCE):
        raise ValueError(f"质量之和必须为 1，实际为 {total!r}")
    # 只修正合法总和的浮点舍入误差，不替调用方归一化非法 BPA。
    return MappingProxyType({key: result[key] / total for key in sorted(result, key=_focal_key)})


def _focal_key(focal: Hypothesis) -> tuple[str, ...]:
    return tuple(sorted(focal))


@dataclass(frozen=True)
class MassFunction:
    """闭世界基本概率分配；拷贝输入并冻结质量，防止验证后被外部修改。"""

    frame: Hypothesis
    masses: Mapping[Hypothesis, float]

    def __post_init__(self) -> None:
        frame = _frame(self.frame)
        object.__setattr__(self, "frame", frame)
        object.__setattr__(self, "masses", _validated_masses(frame, self.masses, allow_empty=False))

    @classmethod
    def vacuous(cls, frame: Iterable[str]) -> MassFunction:
        theta = _frame(frame)
        return cls(theta, {theta: 1.0})

    @classmethod
    def simple_support(
        cls,
        frame: Iterable[str],
        support: Iterable[str] | str | None,
        strength: float = 1.0,
    ) -> MassFunction:
        theta = _frame(frame)
        strength = _unit_interval(strength, "支持强度")
        if support is None:
            return cls.vacuous(theta)
        focal = _hypothesis(support)
        if not focal or not focal <= theta:
            raise ValueError("简单支持必须是框架的非空子集；缺失观测使用 None")
        if focal == theta:
            return cls.vacuous(theta)
        return cls(theta, {focal: strength, theta: 1.0 - strength})

    def _event(self, event: Iterable[str] | str) -> Hypothesis:
        result = _hypothesis(event)
        if not result <= self.frame:
            raise ValueError("查询事件必须是辨识框架的子集")
        return result

    def belief(self, event: Iterable[str] | str) -> float:
        target = self._event(event)
        return fsum(value for focal, value in self.masses.items() if focal <= target)

    def plausibility(self, event: Iterable[str] | str) -> float:
        target = self._event(event)
        return fsum(value for focal, value in self.masses.items() if focal & target)

    def pignistic(self) -> dict[str, float]:
        """BetP 将每个非空焦元的质量均分给其中的单元素状态。"""
        return {
            state: fsum(
                value / len(focal) for focal, value in self.masses.items() if state in focal
            )
            for state in sorted(self.frame)
        }

    def discount(self, reliability: float) -> MassFunction:
        reliability = _unit_interval(reliability, "可靠度")
        masses = {focal: reliability * value for focal, value in self.masses.items()}
        masses[self.frame] = fsum((masses.get(self.frame, 0.0), 1.0 - reliability))
        return MassFunction(self.frame, masses)


class CompleteConflictError(ValueError):
    """Dempster 规则在没有非空幸存质量时无定义。"""

    conflict = 1.0

    def __init__(self) -> None:
        super().__init__("完全冲突 (K=1)：Dempster 规则无法归一化")


@dataclass(frozen=True)
class ConjunctiveResult:
    """未归一合取结果，空集质量即原始冲突系数 K。"""

    frame: Hypothesis
    masses: Mapping[Hypothesis, float]

    def __post_init__(self) -> None:
        frame = _frame(self.frame)
        object.__setattr__(self, "frame", frame)
        object.__setattr__(self, "masses", _validated_masses(frame, self.masses, allow_empty=True))

    @property
    def conflict(self) -> float:
        return self.masses.get(EMPTY, 0.0)

    def dempster(self) -> MassFunction:
        # 对非空质量求和，避免 1-K 在近完全冲突时发生灾难性消减；不设 epsilon。
        normalizer = fsum(value for focal, value in self.masses.items() if focal)
        if normalizer == 0.0:
            raise CompleteConflictError()
        return MassFunction(
            self.frame,
            {focal: value / normalizer for focal, value in self.masses.items() if focal},
        )

    def yager(self) -> MassFunction:
        masses = {focal: value for focal, value in self.masses.items() if focal}
        masses[self.frame] = fsum((masses.get(self.frame, 0.0), self.conflict))
        return MassFunction(self.frame, masses)


def _mass_key(mass: MassFunction) -> tuple[tuple[tuple[str, ...], float], ...]:
    return tuple((_focal_key(focal), value) for focal, value in mass.masses.items())


def conjunctive_combine(
    masses: Iterable[MassFunction], *, frame: Iterable[str] | None = None
) -> ConjunctiveResult:
    """所有来源先批量合取；固定运算次序使输入排列不改变浮点结果。

    空输入需要显式 frame，返回 vacuous。各来源的独立性由调用方保证。
    稀疏存储不会展开整个幂集，但最坏仍有指数个焦元。
    """
    inputs = tuple(masses)
    if any(not isinstance(mass, MassFunction) for mass in inputs):
        raise TypeError("融合输入必须是 MassFunction")
    if frame is None:
        if not inputs:
            raise ValueError("无来源时必须提供辨识框架")
        theta = inputs[0].frame
    else:
        theta = _frame(frame)
    if any(mass.frame != theta for mass in inputs):
        raise ValueError("所有来源必须具有相同的辨识框架")
    accumulator: dict[Hypothesis, float] = {theta: 1.0}
    for mass in sorted(inputs, key=_mass_key):
        terms: dict[Hypothesis, list[float]] = {}
        for left, left_value in accumulator.items():
            for right, right_value in mass.masses.items():
                terms.setdefault(left & right, []).append(left_value * right_value)
        accumulator = {focal: fsum(terms[focal]) for focal in sorted(terms, key=_focal_key)}
    return ConjunctiveResult(theta, accumulator)


def dempster_combine(
    masses: Iterable[MassFunction], *, frame: Iterable[str] | None = None
) -> MassFunction:
    return conjunctive_combine(masses, frame=frame).dempster()


def yager_combine(
    masses: Iterable[MassFunction], *, frame: Iterable[str] | None = None
) -> MassFunction:
    return conjunctive_combine(masses, frame=frame).yager()


@dataclass(frozen=True)
class Evidence:
    """可追溯观测；support=None 表示缺失，时间使用有限数值模拟时钟。"""

    evidence_id: str
    source_id: str
    origin_id: str
    support: Hypothesis | None
    reliability: float
    observed_at: float
    received_at: float

    def __post_init__(self) -> None:
        for name in ("evidence_id", "source_id", "origin_id"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} 必须是非空字符串")
        if self.support is not None:
            support = _hypothesis(self.support)
            if not support:
                raise ValueError("support 不能为空集；缺失观测使用 None")
            object.__setattr__(self, "support", support)
        object.__setattr__(self, "reliability", _unit_interval(self.reliability, "可靠度"))
        for name in ("observed_at", "received_at"):
            object.__setattr__(self, name, _finite_number(getattr(self, name), name))

    def to_mass(self, frame: Iterable[str]) -> MassFunction:
        return MassFunction.simple_support(frame, self.support).discount(self.reliability)


def _evidence_key(evidence: Evidence) -> tuple[float, str, str, float]:
    return (evidence.received_at, evidence.evidence_id, evidence.source_id, evidence.observed_at)


def deduplicate_evidence(
    evidence: Iterable[Evidence],
) -> tuple[tuple[Evidence, ...], tuple[Evidence, ...]]:
    """每个 origin_id 保留最早接收记录，平局按证据 ID、来源 ID、观测时间。

    仅按元数据排序，不读取支持内容、可靠度或任何真值。相同 evidence_id
    的不同载荷被拒绝；同一来源的独立 origin 不会被误删。返回保留和丢弃记录。
    """
    records = tuple(evidence)
    if any(not isinstance(item, Evidence) for item in records):
        raise TypeError("来源输入必须是 Evidence")
    known_ids: dict[str, Evidence] = {}
    groups: dict[str, list[Evidence]] = {}
    for item in records:
        if item.evidence_id in known_ids and known_ids[item.evidence_id] != item:
            raise ValueError(f"evidence_id={item.evidence_id!r} 对应不一致载荷")
        known_ids[item.evidence_id] = item
        groups.setdefault(item.origin_id, []).append(item)
    selected: list[Evidence] = []
    discarded: list[Evidence] = []
    for origin_id in sorted(groups):
        ordered = sorted(groups[origin_id], key=_evidence_key)
        selected.append(ordered[0])
        discarded.extend(ordered[1:])
    return tuple(selected), tuple(discarded)


@dataclass(frozen=True)
class FusionResult:
    mass: MassFunction
    conflict: float
    selected_evidence: tuple[Evidence, ...]
    discarded_evidence: tuple[Evidence, ...]
    rule: str

    @property
    def selected_evidence_ids(self) -> tuple[str, ...]:
        return tuple(item.evidence_id for item in self.selected_evidence)

    @property
    def discarded_evidence_ids(self) -> tuple[str, ...]:
        return tuple(item.evidence_id for item in self.discarded_evidence)

    def pignistic(self) -> dict[str, float]:
        return self.mass.pignistic()


def _fuse(evidence: Iterable[Evidence], frame: Iterable[str], *, rule: str) -> FusionResult:
    theta = _frame(frame)
    records = tuple(evidence)
    # 去重之前验证所有载荷，避免非法重复项被悄悄丢弃。
    for item in records:
        if not isinstance(item, Evidence):
            raise TypeError("来源输入必须是 Evidence")
        if item.support is not None and not item.support <= theta:
            raise ValueError("证据支持必须是辨识框架的子集")
    selected, discarded = deduplicate_evidence(records)
    combined = conjunctive_combine((item.to_mass(theta) for item in selected), frame=theta)
    mass = combined.dempster() if rule == "dempster" else combined.yager()
    return FusionResult(mass, combined.conflict, selected, discarded, rule)


def standard_fusion(evidence: Iterable[Evidence], frame: Iterable[str]) -> FusionResult:
    """可靠度折扣、按 origin 去重、批量 Dempster；完全冲突显式报错。"""
    return _fuse(evidence, frame, rule="dempster")


def robust_fusion(evidence: Iterable[Evidence], frame: Iterable[str]) -> FusionResult:
    """可靠度折扣、按 origin 去重、批量 Yager；冲突一次转入全集。"""
    return _fuse(evidence, frame, rule="yager")
