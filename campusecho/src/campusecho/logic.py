"""有限、无函数符号的正 Horn（Datalog）规则与最小不动点推理。

常量支持 str、int、有限 float、bool 和 None；不同 Python 类型的常量互异。
变量必须显式使用 Var，字符串始终是常量。规则头中的变量必须出现在规则体。
naive 每轮扫描全部已知事实；semi_naive 使用谓词/参数索引和上一轮增量。
两者均同步提交每轮新增事实，trace 为每个新增事实保留第一条有限证明。
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass, field
from time import perf_counter
from typing import Literal

type Constant = str | int | float | bool | None
type Method = Literal["naive", "semi_naive"]
_MISSING = object()


def _validate_name(value: str, label: str) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a string")
    if not value.strip():
        raise ValueError(f"{label} must not be empty")


@dataclass(frozen=True, slots=True)
class Var:
    """按名称相等的变量；变量的作用域是所在规则。"""

    name: str

    def __post_init__(self) -> None:
        _validate_name(self.name, "variable name")


type Term = Constant | Var


def _term_key(term: Term) -> tuple[str, object]:
    if isinstance(term, Var):
        return ("variable", term.name)
    if type(term) not in (str, int, float, bool, type(None)):
        raise TypeError("terms must be Var or scalar constants; function terms are unsupported")
    if isinstance(term, float) and not math.isfinite(term):
        raise ValueError("float constants must be finite")
    return (type(term).__name__, term)


def _same_constant(left: Constant, right: Constant) -> bool:
    # Python 中 True == 1 == 1.0；逻辑常量仍按类型区分，避免静默合并实体。
    return type(left) is type(right) and left == right


@dataclass(frozen=True, slots=True, eq=False)
class Atom:
    """原子式；args 会冻结为 tuple，零元谓词使用空 tuple。"""

    predicate: str
    args: tuple[Term, ...] = ()
    _key: tuple[tuple[str, object], ...] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        _validate_name(self.predicate, "predicate")
        if isinstance(self.args, (str, bytes)):
            raise TypeError("atom args must be an iterable of terms, not a string")
        args = tuple(self.args)
        object.__setattr__(self, "args", args)
        object.__setattr__(self, "_key", tuple(_term_key(term) for term in args))

    @property
    def is_ground(self) -> bool:
        return not any(isinstance(term, Var) for term in self.args)

    @property
    def variables(self) -> frozenset[str]:
        return frozenset(term.name for term in self.args if isinstance(term, Var))

    def __hash__(self) -> int:
        return hash((self.predicate, self._key))

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Atom):
            return NotImplemented
        return self.predicate == other.predicate and self._key == other._key


@dataclass(frozen=True, slots=True)
class Rule:
    """head :- body；空规则体仅允许 ground head，表示一个无条件事实。"""

    id: str
    head: Atom
    body: tuple[Atom, ...] = ()

    def __post_init__(self) -> None:
        _validate_name(self.id, "rule id")
        if not isinstance(self.head, Atom):
            raise TypeError("rule head must be an Atom")
        body = tuple(self.body)
        if not all(isinstance(atom, Atom) for atom in body):
            raise TypeError("rule body must contain only Atoms")
        object.__setattr__(self, "body", body)
        body_variables = frozenset().union(*(atom.variables for atom in body))
        unsafe = self.head.variables - body_variables
        if unsafe:
            raise ValueError(f"unsafe rule {self.id!r}: unbound head variables {sorted(unsafe)}")


@dataclass(frozen=True, slots=True)
class Derivation:
    """单个新增事实的证明；premises 保持原规则体顺序，binding 按变量名排序。"""

    fact: Atom
    rule_id: str
    binding: tuple[tuple[str, Constant], ...]
    premises: tuple[Atom, ...]
    round: int


@dataclass(frozen=True, slots=True)
class InferenceMetrics:
    """rounds 含最后无新增事实的检查轮；candidate_checks 统计实际统一尝试。"""

    method: Method
    rounds: int
    rule_evaluations: int
    candidate_checks: int
    rule_matches: int
    initial_fact_count: int
    derived_fact_count: int
    total_fact_count: int
    elapsed_seconds: float

    def as_dict(self) -> dict[str, str | int | float]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class InferenceResult:
    facts: frozenset[Atom]
    trace: tuple[Derivation, ...]
    metrics: InferenceMetrics
    initial_facts: frozenset[Atom]

    def explain(self, fact: Atom) -> tuple[Derivation, ...]:
        """返回支撑 fact 的证明子图（前提优先）；输入事实返回空 tuple。"""
        if fact not in self.facts:
            raise KeyError(fact)
        proofs = {step.fact: step for step in self.trace}
        required: set[Atom] = set()
        pending = [fact]
        while pending:
            current = pending.pop()
            if current in required:
                continue
            required.add(current)
            if current in proofs:
                pending.extend(proofs[current].premises)
        return tuple(step for step in self.trace if step.fact in required)


@dataclass(slots=True)
class _Counters:
    rule_evaluations: int = 0
    candidate_checks: int = 0
    rule_matches: int = 0


def _atom_order(atom: Atom) -> tuple:
    return atom.predicate, atom._key


class _FactIndex:
    """只在轮次边界追加；联结期间候选列表保持不变。"""

    def __init__(self, facts: Iterable[Atom] = (), *, indexed: bool = True) -> None:
        self.indexed = indexed
        self.all: list[Atom] = []
        self.predicates: dict[tuple[str, int], list[Atom]] = {}
        self.arguments: dict[tuple[str, int, int, tuple[str, object]], list[Atom]] = {}
        self.extend(facts)

    def extend(self, facts: Iterable[Atom]) -> None:
        for fact in sorted(facts, key=_atom_order):
            self.all.append(fact)
            if self.indexed:
                signature = fact.predicate, len(fact.args)
                self.predicates.setdefault(signature, []).append(fact)
                for position, key in enumerate(fact._key):
                    self.arguments.setdefault((*signature, position, key), []).append(fact)

    def has(self, atom: Atom) -> bool:
        return bool(self.predicates.get((atom.predicate, len(atom.args))))

    def candidates(self, atom: Atom, binding: dict[str, Constant]) -> Iterable[Atom]:
        if not self.indexed:
            return self.all
        signature = atom.predicate, len(atom.args)
        best = self.predicates.get(signature, ())
        for position, term in enumerate(atom.args):
            value = binding.get(term.name, _MISSING) if isinstance(term, Var) else term
            if value is not _MISSING:
                matches = self.arguments.get((*signature, position, _term_key(value)), ())
                if len(matches) < len(best):
                    best = matches
        return best


def _unify(atom: Atom, fact: Atom, binding: dict[str, Constant]) -> dict[str, Constant] | None:
    if atom.predicate != fact.predicate or len(atom.args) != len(fact.args):
        return None
    extended = binding.copy()
    for term, value in zip(atom.args, fact.args):
        if isinstance(term, Var):
            previous = extended.get(term.name, _MISSING)
            if previous is _MISSING:
                extended[term.name] = value
            elif not _same_constant(previous, value):
                return None
        elif not _same_constant(term, value):
            return None
    return extended


def _join(
    body: tuple[Atom, ...], sources: tuple[_FactIndex, ...], counters: _Counters
) -> Iterator[tuple[dict[str, Constant], tuple[Atom, ...]]]:
    if not body:
        yield {}, ()
        return
    # 显式回溯栈避免规则体较长时触发 Python 的递归深度限制；逐项产出绑定。
    bindings: list[dict[str, Constant]] = [{}]
    premises: list[Atom] = []
    iterators = [iter(sources[0].candidates(body[0], {}))]
    while iterators:
        depth = len(iterators) - 1
        fact = next(iterators[-1], None)
        if fact is None:
            iterators.pop()
            if iterators:
                bindings.pop()
                premises.pop()
            continue
        counters.candidate_checks += 1
        extended = _unify(body[depth], fact, bindings[-1])
        if extended is None:
            continue
        if depth == len(body) - 1:
            yield extended, (*premises, fact)
        else:
            premises.append(fact)
            bindings.append(extended)
            iterators.append(iter(sources[depth + 1].candidates(body[depth + 1], extended)))


def _validate_program(facts: tuple[Atom, ...], rules: tuple[Rule, ...]) -> None:
    arities: dict[str, int] = {}
    ids: set[str] = set()
    for fact in facts:
        if not isinstance(fact, Atom):
            raise TypeError("facts must contain only Atoms")
        if not fact.is_ground:
            raise ValueError(f"input facts must be ground: {fact!r}")
    atoms = list(facts)
    for rule in rules:
        if not isinstance(rule, Rule):
            raise TypeError("rules must contain only Rules")
        if rule.id in ids:
            raise ValueError(f"duplicate rule id: {rule.id!r}")
        ids.add(rule.id)
        atoms.extend((rule.head, *rule.body))
    for atom in atoms:
        arity = arities.setdefault(atom.predicate, len(atom.args))
        if arity != len(atom.args):
            raise ValueError(f"inconsistent arity for predicate {atom.predicate!r}")


def forward_chain(
    facts: Iterable[Atom], rules: Iterable[Rule], method: Method = "naive"
) -> InferenceResult:
    """返回正 Horn 程序的最小闭包、第一条证明和工作量指标。

    输入不会被修改；事实按集合语义去重，规则按输入顺序应用。仅支持增加事实，
    不支持否定、函数、等式内建、删除或带权推理。非法输入在推理前抛出异常。
    """
    started = perf_counter()
    if method not in ("naive", "semi_naive"):
        raise ValueError("method must be 'naive' or 'semi_naive'")
    fact_input, rule_input = tuple(facts), tuple(rules)
    _validate_program(fact_input, rule_input)
    initial = frozenset(fact_input)
    known = set(initial)
    indexed = method == "semi_naive"
    known_index = _FactIndex(initial, indexed=indexed)
    old_index = _FactIndex()
    delta_index = _FactIndex(initial if indexed else ())
    trace: list[Derivation] = []
    counters = _Counters()
    round_number = 0
    while True:
        round_number += 1
        new: dict[Atom, Derivation] = {}
        for rule in rule_input:
            if not indexed:
                variants = [(known_index,) * len(rule.body)]
            elif not rule.body:
                variants = [()] if round_number == 1 else []
            else:
                # K = old ∪ delta。最左侧 delta 的位置唯一，覆盖全部至少含一个
                # 新前提的组合，包括同一谓词多次出现、以及多个前提同时为新的情况。
                variants = (
                    (old_index,) * pivot
                    + (delta_index,)
                    + (known_index,) * (len(rule.body) - pivot - 1)
                    for pivot, atom in enumerate(rule.body)
                    if delta_index.has(atom)
                )
            for sources in variants:
                counters.rule_evaluations += 1
                for binding, premises in _join(rule.body, sources, counters):
                    counters.rule_matches += 1
                    args = tuple(
                        binding[term.name] if isinstance(term, Var) else term
                        for term in rule.head.args
                    )
                    head = Atom(rule.head.predicate, args)
                    if head not in known and head not in new:
                        new[head] = Derivation(
                            head, rule.id, tuple(sorted(binding.items())), premises, round_number
                        )
        if not new:
            break
        trace.extend(new.values())
        known.update(new)
        if indexed:
            old_index.extend(delta_index.all)
            delta_index = _FactIndex(new)
        known_index.extend(new)
    return InferenceResult(
        facts=frozenset(known),
        trace=tuple(trace),
        metrics=InferenceMetrics(
            method=method,
            rounds=round_number,
            rule_evaluations=counters.rule_evaluations,
            candidate_checks=counters.candidate_checks,
            rule_matches=counters.rule_matches,
            initial_fact_count=len(initial),
            derived_fact_count=len(trace),
            total_fact_count=len(known),
            elapsed_seconds=perf_counter() - started,
        ),
        initial_facts=initial,
    )


__all__ = [
    "Atom",
    "Constant",
    "Derivation",
    "InferenceMetrics",
    "InferenceResult",
    "Method",
    "Rule",
    "Term",
    "Var",
    "forward_chain",
]
