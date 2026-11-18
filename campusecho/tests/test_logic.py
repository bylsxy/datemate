"""正 Horn 规则的语义、增量联结和有限证明回归测试。"""

import random
from itertools import product

import pytest

from campusecho.logic import Atom, Rule, Var, forward_chain

X, Y, Z = Var("X"), Var("Y"), Var("Z")
METHODS = ("naive", "semi_naive")


def atom(predicate, *args):
    return Atom(predicate, args)


def assert_valid_trace(result, rules):
    """独立检查每一步的替换、前提可用性与闭包，没有通过引擎重新求证。"""
    by_id = {rule.id: rule for rule in rules}
    available = set(result.initial_facts)
    first_round = {fact: 0 for fact in available}
    assert len({step.fact for step in result.trace}) == len(result.trace)
    assert [step.round for step in result.trace] == sorted(step.round for step in result.trace)
    for step in result.trace:
        rule = by_id[step.rule_id]
        substitution = dict(step.binding)

        def ground(template, substitution=substitution):
            return atom(
                template.predicate,
                *(substitution[t.name] if isinstance(t, Var) else t for t in template.args),
            )

        assert step.fact == ground(rule.head)
        assert step.premises == tuple(map(ground, rule.body))
        assert all(premise in available for premise in step.premises)
        assert all(first_round[premise] < step.round for premise in step.premises)
        assert step.fact not in available
        available.add(step.fact)
        first_round[step.fact] = step.round
    assert available == result.facts
    assert result.metrics.derived_fact_count == len(result.trace)
    assert result.metrics.total_fact_count == len(result.facts)


def grounded_oracle(facts, rules, domain):
    """小有限域完全实例化 oracle，不使用待测引擎的统一或增量逻辑。"""
    ground_rules = []
    for rule in rules:
        names = sorted(set().union(*(a.variables for a in (rule.head, *rule.body))))
        for values in product(domain, repeat=len(names)):
            substitution = dict(zip(names, values))

            def instantiate(template, substitution=substitution):
                return atom(
                    template.predicate,
                    *(substitution[t.name] if isinstance(t, Var) else t for t in template.args),
                )

            ground_rules.append((instantiate(rule.head), tuple(map(instantiate, rule.body))))
    known = set(facts)
    while True:
        new = {
            head for head, body in ground_rules if all(premise in known for premise in body)
        } - known
        if not new:
            return frozenset(known)
        known.update(new)


@pytest.mark.parametrize("method", METHODS)
def test_join_constants_repeated_variables_and_multiple_bindings(method):
    facts = [
        atom("edge", "a", "b"),
        atom("edge", "a", "c"),
        atom("edge", "b", "b"),
        atom("color", "b", "blue"),
        atom("color", "c", "blue"),
        atom("color", "a", "red"),
    ]
    rules = [
        Rule("join", atom("blue_neighbor", X, Y), (atom("edge", X, Y), atom("color", Y, "blue"))),
        Rule("loop", atom("self", X), (atom("edge", X, X),)),
    ]
    result = forward_chain(facts, rules, method)
    assert result.facts - set(facts) == {
        atom("blue_neighbor", "a", "b"),
        atom("blue_neighbor", "a", "c"),
        atom("blue_neighbor", "b", "b"),
        atom("self", "b"),
    }
    assert_valid_trace(result, rules)


@pytest.mark.parametrize("method", METHODS)
def test_recursion_mutual_cycles_and_nonlinear_rule_terminate(method):
    facts = [atom("edge", "a", "b"), atom("edge", "b", "c"), atom("edge", "c", "a")]
    rules = [
        Rule("base", atom("path", X, Y), (atom("edge", X, Y),)),
        Rule("nonlinear", atom("path", X, Z), (atom("path", X, Y), atom("path", Y, Z))),
        Rule("seen", atom("seen", X), (atom("path", X, Y),)),
        Rule("cycle1", atom("visited", X), (atom("seen", X),)),
        Rule("cycle2", atom("seen", X), (atom("visited", X),)),
    ]
    result = forward_chain(facts, rules, method)
    assert {f for f in result.facts if f.predicate == "path"} == {
        atom("path", a, b) for a, b in product("abc", repeat=2)
    }
    assert result.metrics.rounds < 10
    assert_valid_trace(result, rules)


def test_delta_in_every_body_position_and_multiple_new_premises():
    # 此处第二轮只有 left 是旧事实；right 和 center 同时新增，覆盖非首位 delta。
    facts = [atom("left", "a"), atom("seed", "a")]
    rules = [
        Rule("r", atom("right", X), (atom("seed", X),)),
        Rule("c", atom("center", X), (atom("seed", X),)),
        Rule("join", atom("answer", X), (atom("left", X), atom("center", X), atom("right", X))),
        Rule("repeat", atom("twice", X), (atom("right", X), atom("right", X))),
    ]
    naive = forward_chain(facts, rules, "naive")
    optimized = forward_chain(facts, rules, "semi_naive")
    assert optimized.facts == naive.facts
    assert atom("answer", "a") in optimized.facts
    assert atom("twice", "a") in optimized.facts
    assert optimized.metrics.rule_matches == 4  # 不重复枚举两个 delta 前提的同一组合。
    assert_valid_trace(optimized, rules)


@pytest.mark.parametrize("fresh_position", range(3))
def test_only_fresh_body_position_can_be_first_middle_or_last(fresh_position):
    predicates = ("first", "middle", "last")
    facts = [
        atom(predicate, "a")
        for index, predicate in enumerate(predicates)
        if index != fresh_position
    ]
    facts.append(atom("seed", "a"))
    rules = [
        Rule("fresh", atom(predicates[fresh_position], X), (atom("seed", X),)),
        Rule("join", atom("answer", X), tuple(atom(predicate, X) for predicate in predicates)),
    ]
    result = forward_chain(facts, rules, "semi_naive")
    assert atom("answer", "a") in result.facts
    assert result.facts == forward_chain(facts, rules, "naive").facts
    assert_valid_trace(result, rules)


@pytest.mark.parametrize("method", METHODS)
def test_unseeded_cycles_do_not_invent_facts_and_shared_heads_have_one_proof(method):
    rules = [
        Rule("p_to_q", atom("q", X), (atom("p", X),)),
        Rule("q_to_p", atom("p", X), (atom("q", X),)),
        Rule("existential", atom("present"), (atom("person", X),)),
    ]
    result = forward_chain([atom("person", "a"), atom("person", "b")], rules, method)
    assert result.facts == {atom("person", "a"), atom("person", "b"), atom("present")}
    assert len(result.trace) == 1
    assert_valid_trace(result, rules)


@pytest.mark.parametrize("method", METHODS)
def test_unconditional_rules_zero_arity_duplicates_and_no_seed(method):
    rules = [
        Rule("start", atom("start")),
        Rule("person", atom("person", "a")),
        Rule("ready", atom("ready", X), (atom("start"), atom("person", X))),
    ]
    result = forward_chain([], rules, method)
    assert result.facts == {atom("start"), atom("person", "a"), atom("ready", "a")}
    assert result.metrics.rounds == 3
    assert_valid_trace(result, rules)
    seeded = forward_chain([atom("start"), atom("start")], [], method)
    assert seeded.initial_facts == {atom("start")}
    assert seeded.trace == ()
    assert seeded.metrics.initial_fact_count == 1
    empty = forward_chain([], [], method)
    assert empty.facts == frozenset()
    assert empty.metrics.rounds == 1


@pytest.mark.parametrize("method", METHODS)
def test_constants_are_type_sensitive_and_none_is_a_valid_binding(method):
    values = [True, 1, 1.0, "1", None]
    facts = [atom("value", value) for value in values]
    rules = [
        Rule("copy", atom("copied", X), (atom("value", X),)),
        Rule("int", atom("integer"), (atom("value", 1),)),
    ]
    result = forward_chain(facts, rules, method)
    assert len(frozenset(facts)) == 5
    assert {f for f in result.facts if f.predicate == "copied"} == {
        atom("copied", v) for v in values
    }
    assert_valid_trace(result, rules)
    assert atom("integer") not in forward_chain([atom("value", True)], rules, method).facts
    repeated = [Rule("same", atom("same"), (atom("pair", X, X),))]
    assert atom("same") not in forward_chain([atom("pair", True, 1)], repeated, method).facts


def test_explain_returns_dependency_subgraph_and_unknown_fact_fails():
    rules = [
        Rule("b", atom("b", X), (atom("a", X),)),
        Rule("c", atom("c", X), (atom("b", X),)),
        Rule("d", atom("d", X), (atom("a", X),)),
    ]
    result = forward_chain([atom("a", "x")], rules, "semi_naive")
    assert [step.rule_id for step in result.explain(atom("c", "x"))] == ["b", "c"]
    assert result.explain(atom("a", "x")) == ()
    with pytest.raises(KeyError):
        result.explain(atom("missing"))


def test_predicate_and_bound_argument_indexes_reduce_candidate_checks():
    facts = [atom("edge", i, i + 1) for i in range(14)]
    facts.extend(atom(f"noise_{i}", "unused") for i in range(80))
    rules = [
        Rule("base", atom("path", X, Y), (atom("edge", X, Y),)),
        Rule("extend", atom("path", X, Z), (atom("path", X, Y), atom("edge", Y, Z))),
    ]
    naive = forward_chain(facts, rules)
    optimized = forward_chain(facts, rules, "semi_naive")
    assert naive.facts == optimized.facts
    assert optimized.metrics.candidate_checks * 10 < naive.metrics.candidate_checks
    assert optimized.metrics.rule_matches < naive.metrics.rule_matches
    assert optimized.metrics.as_dict()["method"] == "semi_naive"
    assert optimized.metrics.elapsed_seconds >= 0


def test_random_finite_programs_agree_with_grounded_oracle():
    rng = random.Random(20261103)
    domain = ("a", "b", "c")
    binary = ("p", "q", "r")
    for case in range(25):
        facts = {atom(p, a, b) for p, a, b in product(binary, domain, domain) if rng.random() < 0.2}
        rules = []
        for index in range(6):
            head_pred, left_pred, right_pred = (rng.choice(binary) for _ in range(3))
            shape = rng.randrange(4)
            if shape == 0:
                head, body = atom(head_pred, X, Z), (atom(left_pred, X, Y), atom(right_pred, Y, Z))
            elif shape == 1:
                head, body = atom(head_pred, X, Y), (atom(left_pred, Y, X),)
            elif shape == 2:
                head, body = (
                    atom(head_pred, X, "a"),
                    (atom(left_pred, X, X), atom(right_pred, "a", X)),
                )
            else:
                head, body = atom(head_pred, X, X), (atom(left_pred, X, Y), atom(right_pred, X, Y))
            rules.append(Rule(f"{case}:{index}", head, body))
        expected = grounded_oracle(facts, rules, domain)
        for method in METHODS:
            result = forward_chain(facts, rules, method)
            assert result.facts == expected, (case, method)
            assert_valid_trace(result, rules)


def test_inputs_are_not_modified_generators_supported_and_trace_is_deterministic():
    facts = [atom("a", "z"), atom("a", "b")]
    rules = [Rule("b", atom("b", X), (atom("a", X),))]
    original_facts, original_rules = facts.copy(), rules.copy()
    first = forward_chain(iter(facts), iter(rules), "semi_naive")
    second = forward_chain(reversed(facts), rules, "semi_naive")
    assert facts == original_facts and rules == original_rules
    assert first.trace == second.trace


@pytest.mark.parametrize("method", METHODS)
def test_long_rule_body_uses_iterative_backtracking(method):
    result = forward_chain(
        [atom("flag")], [Rule("long", atom("ok"), (atom("flag"),) * 1100)], method
    )
    assert atom("ok") in result.facts


@pytest.mark.parametrize(
    "build",
    [
        lambda: Var(""),
        lambda: Atom(" "),
        lambda: Rule("", atom("p")),
        lambda: Atom("p", (float("nan"),)),
        lambda: Atom("p", (float("inf"),)),
        lambda: Rule("unsafe", atom("p", X), (atom("q", Y),)),
        lambda: Rule("unsafe_empty", atom("p", X)),
    ],
)
def test_invalid_names_nonfinite_constants_and_unsafe_rules_rejected(build):
    with pytest.raises(ValueError):
        build()


@pytest.mark.parametrize(
    "build",
    [
        lambda: Var(1),
        lambda: Atom(1),
        lambda: Atom("p", "abc"),
        lambda: Atom("p", (("function", "a"),)),
        lambda: Atom("p", ([],)),
        lambda: Atom("p", (atom("f", "a"),)),
        lambda: Rule("bad", "head"),
        lambda: Rule("bad", atom("p"), ("body",)),
    ],
)
def test_wrong_types_and_function_terms_rejected(build):
    with pytest.raises(TypeError):
        build()


@pytest.mark.parametrize(
    "facts,rules",
    [
        ([atom("p", X)], []),
        ([atom("p", "a"), atom("p")], []),
        ([], [Rule("arity", atom("p", "a"), (atom("p"),))]),
        ([], [Rule("duplicate", atom("p")), Rule("duplicate", atom("q"))]),
    ],
)
def test_program_validation_rejects_nonground_facts_arity_and_duplicate_ids(facts, rules):
    with pytest.raises(ValueError):
        forward_chain(facts, rules)


def test_program_validation_rejects_wrong_element_types_and_unknown_method():
    with pytest.raises(TypeError):
        forward_chain(["fact"], [])
    with pytest.raises(TypeError):
        forward_chain([], ["rule"])
    with pytest.raises(ValueError):
        forward_chain([], [], "unknown")
