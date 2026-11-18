"""证据理论的解析结果、来源语义与数值边界。"""

from dataclasses import FrozenInstanceError, replace
from itertools import permutations, product
from math import fsum

import pytest

from campusecho.evidence import (
    CompleteConflictError,
    ConjunctiveResult,
    Evidence,
    MassFunction,
    conjunctive_combine,
    deduplicate_evidence,
    dempster_combine,
    robust_fusion,
    standard_fusion,
    yager_combine,
)

A = frozenset({"a"})
B = frozenset({"b"})
C = frozenset({"c"})
AB = A | B
THETA = A | B | C
EMPTY = frozenset()


def observation(
    evidence_id="e1",
    source_id="s1",
    origin_id="o1",
    support=A,
    reliability=0.8,
    observed_at=0,
    received_at=1,
):
    return Evidence(
        evidence_id, source_id, origin_id, support, reliability, observed_at, received_at
    )


def assert_masses(mass, expected):
    assert dict(mass.masses) == pytest.approx(expected)
    assert fsum(mass.masses.values()) == pytest.approx(1.0)


def test_belief_plausibility_and_pignistic_on_composite_focal_elements():
    mass = MassFunction(THETA, {A: 0.2, AB: 0.3, THETA: 0.5})
    assert mass.belief("a") == pytest.approx(0.2)
    assert mass.belief(AB) == pytest.approx(0.5)
    assert mass.plausibility("a") == pytest.approx(1.0)
    assert mass.plausibility(B) == pytest.approx(0.8)
    assert mass.belief(EMPTY) == mass.plausibility(EMPTY) == 0.0
    assert mass.belief(THETA) == mass.plausibility(THETA) == pytest.approx(1.0)
    assert mass.pignistic() == pytest.approx(
        {"a": 0.2 + 0.15 + 1 / 6, "b": 0.15 + 1 / 6, "c": 1 / 6}
    )
    for event in (EMPTY, A, AB, THETA):
        assert mass.plausibility(event) == pytest.approx(1 - mass.belief(THETA - event))


def test_simple_support_missing_and_singleton_frame():
    assert_masses(MassFunction.simple_support(THETA, A, 0.7), {A: 0.7, THETA: 0.3})
    assert_masses(MassFunction.simple_support(THETA, "a"), {A: 1.0})
    assert_masses(MassFunction.simple_support(THETA, A, 0), {THETA: 1.0})
    assert_masses(MassFunction.simple_support(THETA, THETA, 0.7), {THETA: 1.0})
    assert_masses(MassFunction.simple_support(THETA, None, 0.7), {THETA: 1.0})
    assert MassFunction.vacuous(THETA).pignistic() == pytest.approx(dict.fromkeys(THETA, 1 / 3))
    assert MassFunction.simple_support(A, A, 0.7).pignistic() == {"a": 1.0}


def test_discount_adds_lost_reliability_to_ignorance():
    original = MassFunction(THETA, {A: 0.2, AB: 0.3, THETA: 0.5})
    assert_masses(original.discount(0.4), {A: 0.08, AB: 0.12, THETA: 0.8})
    assert original.discount(1) == original
    assert original.discount(0) == MassFunction.vacuous(THETA)
    assert original.discount(0.5).discount(0.4).masses == pytest.approx(
        original.discount(0.2).masses
    )
    assert MassFunction.vacuous(THETA).discount(0.2) == MassFunction.vacuous(THETA)


@pytest.mark.parametrize("value", [-0.01, 1.01, float("nan"), float("inf"), -float("inf")])
def test_rejects_invalid_mass_and_reliability(value):
    with pytest.raises(ValueError):
        MassFunction(THETA, {A: value, THETA: 1 - value})
    with pytest.raises(ValueError):
        MassFunction.vacuous(THETA).discount(value)
    with pytest.raises(ValueError):
        observation(reliability=value)
    with pytest.raises(ValueError):
        MassFunction.simple_support(THETA, None, value)


@pytest.mark.parametrize("value", [True, "0.5", None])
def test_rejects_non_numeric_mass_and_reliability(value):
    with pytest.raises(TypeError):
        MassFunction(THETA, {A: value})
    with pytest.raises(TypeError):
        observation(reliability=value)


@pytest.mark.parametrize(
    "masses",
    [{}, {A: 0.8}, {A: 0.6, B: 0.6}, {EMPTY: 0.1, A: 0.9}, {frozenset({"outside"}): 1.0}],
)
def test_rejects_invalid_bpa(masses):
    with pytest.raises(ValueError):
        MassFunction(THETA, masses)


def test_frame_query_and_support_validation():
    with pytest.raises(ValueError):
        MassFunction.vacuous(EMPTY)
    with pytest.raises(TypeError):
        MassFunction.vacuous("abc")
    with pytest.raises(ValueError):
        MassFunction.vacuous(frozenset({""}))
    with pytest.raises(TypeError):
        MassFunction(THETA, {"a": 1.0})
    for support in (EMPTY, frozenset({"outside"})):
        with pytest.raises(ValueError):
            MassFunction.simple_support(THETA, support)
    for query in ("outside", {"a", "outside"}):
        with pytest.raises(ValueError):
            MassFunction.vacuous(THETA).belief(query)
        with pytest.raises(ValueError):
            MassFunction.vacuous(THETA).plausibility(query)


def test_mass_copies_input_and_is_immutable():
    values = {A: 0.7, THETA: 0.3}
    mass = MassFunction(THETA, values)
    values[A] = 0.1
    assert mass.masses[A] == pytest.approx(0.7)
    with pytest.raises(TypeError):
        mass.masses[A] = 0.1
    with pytest.raises(FrozenInstanceError):
        mass.frame = A


def test_two_source_analytic_conjunction_dempster_and_yager():
    sources = [MassFunction.simple_support(AB, A, 0.6), MassFunction.simple_support(AB, B, 0.7)]
    result = conjunctive_combine(sources)
    assert_masses(result, {EMPTY: 0.42, A: 0.18, B: 0.28, AB: 0.12})
    assert result.conflict == pytest.approx(0.42)
    assert_masses(dempster_combine(sources), {A: 0.18 / 0.58, B: 0.28 / 0.58, AB: 0.12 / 0.58})
    assert_masses(yager_combine(sources), {A: 0.18, B: 0.28, AB: 0.54})


def test_complete_conflict_is_explicit_and_yager_returns_ignorance():
    sources = [MassFunction.simple_support(AB, A), MassFunction.simple_support(AB, B)]
    combined = conjunctive_combine(sources)
    assert combined.conflict == 1.0
    assert_masses(combined, {EMPTY: 1.0})
    with pytest.raises(CompleteConflictError, match="K=1") as captured:
        dempster_combine(sources)
    assert captured.value.conflict == 1.0
    assert_masses(yager_combine(sources), {AB: 1.0})


def test_near_complete_conflict_is_not_mistaken_for_complete_conflict():
    epsilon = 1e-14
    sources = [MassFunction.simple_support(AB, A, 1 - epsilon), MassFunction.simple_support(AB, B)]
    assert conjunctive_combine(sources).conflict > 1 - 1e-12
    assert_masses(dempster_combine(sources), {B: 1.0})
    # 浮点 K 可舍入为 1，仍须保留可表示的正幸存质量，不用 epsilon 硬除。
    tiny_survivor = ConjunctiveResult(AB, {EMPTY: 1.0, A: 1e-30})
    assert_masses(tiny_survivor.dempster(), {A: 1.0})


def test_three_source_yager_moves_conflict_only_once():
    sources = [MassFunction.simple_support(AB, support) for support in (A, B, A)]
    for order in permutations(sources):
        assert_masses(yager_combine(order), {AB: 1.0})
    # 逐对 Yager 会先把冲突变成全集，再错误地收缩到 a，故不能用于 n 源批量 API。
    pairwise = yager_combine([yager_combine(sources[:2]), sources[2]])
    assert_masses(pairwise, {A: 1.0})


def test_multisource_order_invariance_against_cartesian_product_oracle():
    sources = [
        MassFunction(THETA, {A: 0.3, AB: 0.2, THETA: 0.5}),
        MassFunction.simple_support(THETA, B, 0.7),
        MassFunction(THETA, {C: 0.1, AB: 0.4, THETA: 0.5}),
        MassFunction.simple_support(THETA, A | C, 0.2),
    ]
    terms = {}
    for combination in product(*(tuple(mass.masses.items()) for mass in sources)):
        intersection, value = THETA, 1.0
        for focal, component in combination:
            intersection &= focal
            value *= component
        terms.setdefault(intersection, []).append(value)
    expected = {focal: fsum(values) for focal, values in terms.items()}
    baseline = conjunctive_combine(sources)
    assert_masses(baseline, expected)
    for order in permutations(sources):
        assert conjunctive_combine(order) == baseline
        assert dempster_combine(order) == baseline.dempster()
        assert yager_combine(order) == baseline.yager()


def test_empty_sources_vacuous_identity_and_frame_mismatch():
    for combine in (dempster_combine, yager_combine):
        assert combine([], frame=THETA) == MassFunction.vacuous(THETA)
        single = MassFunction.simple_support(THETA, A, 0.8)
        assert combine([single, MassFunction.vacuous(THETA)]) == single
        with pytest.raises(ValueError):
            combine([])
        with pytest.raises(ValueError):
            combine([single, MassFunction.vacuous(AB)])
        with pytest.raises(ValueError):
            combine([single], frame=AB)
        with pytest.raises(TypeError):
            combine([None], frame=THETA)


def test_evidence_converts_missing_and_discounted_support():
    assert_masses(observation().to_mass(THETA), {A: 0.8, THETA: 0.2})
    assert observation(support="a").support == A
    assert observation(support=None).to_mass(THETA) == MassFunction.vacuous(THETA)
    assert observation(reliability=0).to_mass(THETA) == MassFunction.vacuous(THETA)


@pytest.mark.parametrize("field", ["evidence_id", "source_id", "origin_id"])
def test_evidence_requires_traceable_identifiers(field):
    with pytest.raises(ValueError):
        observation(**{field: " "})


@pytest.mark.parametrize("field", ["observed_at", "received_at"])
@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_evidence_rejects_nonfinite_time(field, value):
    with pytest.raises(ValueError):
        observation(**{field: value})


def test_deduplication_retains_first_received_origin_without_truth_or_reliability_ranking():
    earliest = observation(evidence_id="early", support=A, reliability=0.2, received_at=1)
    relay = observation(
        evidence_id="relay", source_id="s2", support=B, reliability=0.99, received_at=2
    )
    independent = observation(evidence_id="independent", origin_id="o2", support=B)
    for order in permutations([relay, earliest, independent]):
        selected, discarded = deduplicate_evidence(order)
        assert tuple(item.evidence_id for item in selected) == ("early", "independent")
        assert discarded == (relay,)
    changed_content = replace(earliest, support=C, reliability=0.01)
    assert deduplicate_evidence([relay, changed_content])[0] == (changed_content,)


def test_deduplication_breaks_timestamp_ties_by_evidence_id_and_detects_id_collisions():
    later_id = observation(evidence_id="z")
    earlier_id = observation(evidence_id="a", source_id="s9", support=B)
    assert deduplicate_evidence([later_id, earlier_id]) == ((earlier_id,), (later_id,))
    assert deduplicate_evidence([earlier_id, earlier_id]) == ((earlier_id,), (earlier_id,))
    with pytest.raises(ValueError, match="不一致载荷"):
        deduplicate_evidence([earlier_id, replace(earlier_id, support=C)])


def test_fusion_exposes_provenance_and_does_not_amplify_relayed_evidence():
    original = observation()
    relay = replace(original, evidence_id="relay", source_id="s2", received_at=2)
    for fuse in (standard_fusion, robust_fusion):
        result = fuse([relay, original], THETA)
        assert result.mass == original.to_mass(THETA)
        assert result.conflict == 0
        assert result.selected_evidence_ids == ("e1",)
        assert result.discarded_evidence_ids == ("relay",)
        assert result.pignistic() == result.mass.pignistic()
        assert fuse([], THETA).mass == MassFunction.vacuous(THETA)
        assert fuse([observation(support=None)], THETA).mass == MassFunction.vacuous(THETA)


def test_fusion_reliability_and_conflict_match_the_low_level_rules():
    records = [
        observation(),
        observation(evidence_id="e2", origin_id="o2", support=B, reliability=0.6),
    ]
    masses = [record.to_mass(THETA) for record in records]
    for order in permutations(records):
        standard = standard_fusion(order, THETA)
        robust = robust_fusion(order, THETA)
        assert standard.mass == dempster_combine(masses)
        assert robust.mass == yager_combine(masses)
        assert standard.conflict == robust.conflict == pytest.approx(0.48)
        assert standard.rule == "dempster"
        assert robust.rule == "yager"


def test_high_level_complete_conflict_and_invalid_discarded_support():
    first = observation(reliability=1)
    opposite = observation(evidence_id="e2", origin_id="o2", support=B, reliability=1)
    with pytest.raises(CompleteConflictError):
        standard_fusion([first, opposite], THETA)
    assert robust_fusion([first, opposite], THETA).conflict == 1
    assert_masses(robust_fusion([first, opposite], THETA).mass, {THETA: 1.0})
    illegal_relay = replace(first, evidence_id="bad", support=frozenset({"outside"}), received_at=2)
    with pytest.raises(ValueError):
        robust_fusion([first, illegal_relay], THETA)
    with pytest.raises(TypeError):
        robust_fusion([None], THETA)
