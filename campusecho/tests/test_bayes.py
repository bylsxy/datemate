"""贝叶斯通道的手算、联合分布穷举、因果可见性与数值边界。"""

from dataclasses import replace
from itertools import combinations, permutations, product
from math import exp, fsum, isfinite
from types import SimpleNamespace

import pytest

from campusecho.bayes import BayesResult, LocationBayes, ZeroLikelihoodError
from campusecho.evidence import Evidence

FRAME = ("library", "canteen", "dorm")


def observation(
    evidence_id="e1",
    source_id="s1",
    origin_id="o1",
    support=None,
    reliability=0.8,
    observed_at=0.0,
    received_at=0.0,
):
    if support is None:
        support = frozenset({"library"})
    return Evidence(
        evidence_id, source_id, origin_id, support, reliability, observed_at, received_at
    )


def assert_distribution(result, expected):
    assert isinstance(result, BayesResult)
    assert result.probabilities == pytest.approx(expected, abs=1e-12)
    assert fsum(result.probabilities.values()) == pytest.approx(1.0, abs=1e-14)
    assert all(isfinite(value) and 0 <= value <= 1 for value in result.probabilities.values())


def enumerate_joint(frame, prior, records, now, tau):
    """独立枚举位置及所有二元报告，汇总联合分布中的全 yes 事件。"""
    matching = dict.fromkeys(frame, 0.0)
    total = 0.0
    for state, reports in product(frame, product((False, True), repeat=len(records))):
        probability = prior[state]
        for record, yes in zip(records, reports):
            r = record.reliability * exp(-(now - record.observed_at) / tau)
            likelihood = (r / len(record.support) if state in record.support else 0.0) + (
                1 - r
            ) / len(frame)
            probability *= likelihood if yes else 1 - likelihood
        total += probability
        if all(reports):
            matching[state] += probability
    assert total == pytest.approx(1.0)
    denominator = fsum(matching.values())
    return {state: value / denominator for state, value in matching.items()}


def test_empty_evidence_returns_exact_nonuniform_prior_and_keeps_frame_order():
    prior = {"library": 0.6, "canteen": 0.3, "dorm": 0.1}
    model = LocationBayes(FRAME, prior)
    result = model.infer([], now=5)
    assert_distribution(result, prior)
    assert tuple(result.probabilities) == FRAME
    assert result.selected_evidence_ids == ()
    assert result.trace["status"] == "prior"
    result.probabilities["library"] = 0.0
    prior["library"] = 0.0
    assert model.infer([], 5).probabilities["library"] == 0.6


def test_single_report_matches_hand_calculation_with_nonuniform_prior():
    # r=.6, n=3: likelihood=(11/15, 2/15, 2/15), prior=(.5,.3,.2).
    result = LocationBayes(FRAME, dict(zip(FRAME, (0.5, 0.3, 0.2)))).infer(
        [observation(reliability=0.6)], now=0
    )
    assert_distribution(result, dict(zip(FRAME, (11 / 13, 6 / 65, 4 / 65))))
    assert result.selected_evidence_ids == ("e1",)


def test_composite_support_is_likelihood_not_bpa_or_posterior():
    prior = dict(zip(FRAME, (0.6, 0.3, 0.1)))
    result = LocationBayes(FRAME, prior).infer(
        [observation(support=frozenset(FRAME[:2]), reliability=0.75)], now=0
    )
    # channel=(11/24,11/24,2/24), not simple support BPA's BetP used as a posterior.
    assert_distribution(result, dict(zip(FRAME, (66 / 101, 33 / 101, 2 / 101))))


@pytest.mark.parametrize("frame", [("a",), ("a", "b"), ("a", "b", "c")])
def test_pgmpy_matches_exhaustive_normalized_joint_channels(frame):
    prior = {
        state: (index + 1) / sum(range(1, len(frame) + 1)) for index, state in enumerate(frame)
    }
    subsets = [
        frozenset(group) for size in range(1, len(frame) + 1) for group in combinations(frame, size)
    ]
    for first, second in product(subsets, repeat=2):
        records = [
            observation("e1", "s1", "o1", first, 0.8, 0, 1),
            observation("e2", "s2", "o2", second, 0.35, 2, 3),
        ]
        result = LocationBayes(frame, prior, tau=12).infer(records, now=4)
        assert_distribution(result, enumerate_joint(frame, prior, records, 4, 12))


def test_missing_vacuous_and_zero_reliability_leave_prior_unchanged():
    prior = dict(zip(FRAME, (0.15, 0.25, 0.6)))
    records = [
        replace(observation(), support=None),
        observation("e2", "s2", "o2", frozenset(FRAME), 1),
        observation("e3", "s3", "o3", reliability=0),
    ]
    result = LocationBayes(FRAME, prior).infer(records, 0)
    assert result.probabilities == prior
    assert result.selected_evidence_ids == ("e1", "e2", "e3")
    assert [entry["status"] for entry in result.trace["observations"]] == [
        "missing",
        "vacuous",
        "zero_reliability",
    ]


def test_origin_duplicates_never_add_confidence_or_select_by_content():
    original = observation(reliability=0.3)
    relay = observation("relay", "relay-source", "o1", frozenset({"dorm"}), 1, 0, 1)
    model = LocationBayes(FRAME)
    expected = model.infer([original], 1)
    for records in ([original, relay], [relay, original], [original] * 5):
        result = model.infer(records, 1)
        assert result.probabilities == expected.probabilities
        assert result.selected_evidence_ids == ("e1",)
    # 同一 source 的不同原始报告仍是不同观测。
    independent = replace(original, evidence_id="independent", origin_id="o2")
    assert (
        model.infer([original, independent], 1).probabilities["library"]
        > expected.probabilities["library"]
    )


def test_origin_metadata_tie_break_matches_evidence_module():
    first = observation("a", "z", "o1", reliability=0.2)
    second = observation("b", "a", "o1", frozenset({"dorm"}), 1)
    model = LocationBayes(FRAME)
    result = model.infer([second, first], 0)
    assert result.selected_evidence_ids == ("a",)
    assert result.probabilities == model.infer([first], 0).probabilities


def test_future_reports_are_invisible_before_deduplication_and_validation():
    present = observation()
    # 相同 ID 的未来不一致载荷不影响当前推理；不可见的框架外内容也不被读取。
    future = replace(present, support=frozenset({"unknown"}), received_at=11)
    future_observed = observation("f2", "s2", "o2", observed_at=11, received_at=0)
    model = LocationBayes(FRAME)
    expected = model.infer([present], now=10)
    assert model.infer([present, future, future_observed], 10) == expected
    assert model.infer([future], 10).selected_evidence_ids == ()
    with pytest.raises(ValueError, match="frame"):
        model.infer([future], 11)


def test_received_time_boundary_is_inclusive():
    record = observation(received_at=2)
    model = LocationBayes(FRAME)
    assert model.infer([record], 1).selected_evidence_ids == ()
    assert model.infer([record], 2).selected_evidence_ids == ("e1",)


def test_exponential_age_discount_has_explicit_design_parameter():
    model = LocationBayes(("library", "dorm"), tau=10)
    record = observation(reliability=0.8)
    now = 10
    result = model.infer([record], now)
    r = 0.8 * exp(-1)
    assert_distribution(result, {"library": (1 + r) / 2, "dorm": (1 - r) / 2})
    assert result.trace["tau"] == 10
    assert result.trace["tau_is_design_parameter"] is True
    assert result.trace["observations"][0]["effective_reliability"] == pytest.approx(r)
    assert LocationBayes(FRAME).tau == 300


def test_invisible_world_truth_has_no_inference_entry_point():
    view = SimpleNamespace(evidence_for=lambda target: (observation(),), tick=0)
    world = SimpleNamespace(true_locations={"student": "library"})
    model = LocationBayes(FRAME)
    before = model.infer(view.evidence_for("student"), now=view.tick)
    world.true_locations["student"] = "dorm"
    assert model.infer(view.evidence_for("student"), now=view.tick) == before
    with pytest.raises(TypeError):
        model.infer([], now=0, world=world)


def test_permutation_and_repeated_calls_do_not_change_the_result():
    model = LocationBayes(FRAME)
    records = [
        observation(),
        observation("e2", "s2", "o2", frozenset({"dorm"}), 0.4),
        observation("e3", "s3", "o3", frozenset(FRAME[:2]), 0.9),
    ]
    expected = model.infer(records, 1)
    for ordering in permutations(records):
        assert model.infer(ordering, 1) == expected
    assert model.infer([], 1).probabilities == dict.fromkeys(FRAME, 1 / 3)


def test_hard_conflict_and_prior_impossible_event_raise_explicit_error():
    records = [
        observation(reliability=1),
        observation("e2", "s2", "o2", frozenset({"dorm"}), 1),
    ]
    with pytest.raises(ZeroLikelihoodError, match="零总似然") as failure:
        LocationBayes(FRAME).infer(records, 0)
    assert failure.value.selected_evidence_ids == ("e1", "e2")
    with pytest.raises(ZeroLikelihoodError):
        LocationBayes(FRAME, dict(zip(FRAME, (0, 0.3, 0.7)))).infer(records[:1], 0)


def test_near_conflict_remains_finite_and_normalized():
    records = [
        observation(reliability=1 - 1e-15),
        observation("e2", "s2", "o2", frozenset({"dorm"}), 1 - 1e-15),
    ]
    result = LocationBayes(FRAME).infer(records, 0)
    assert_distribution(result, {"library": 0.5, "canteen": 0, "dorm": 0.5})


def test_many_conflicting_reports_do_not_underflow_to_nan():
    records = [
        observation(f"e{i}", f"s{i}", f"o{i}", frozenset({FRAME[i % 2]}), 0.8) for i in range(1000)
    ]
    result = LocationBayes(FRAME).infer(records, 0)
    assert_distribution(result, {"library": 0.5, "canteen": 0.5, "dorm": 0.0})


def test_pgmpy_is_called_with_a_valid_observed_binary_child(monkeypatch):
    from campusecho import bayes

    original_query = bayes.VariableElimination.query
    models = []

    def query(inference, *args, **kwargs):
        assert inference.model.check_model()
        models.append(inference.model)
        return original_query(inference, *args, **kwargs)

    monkeypatch.setattr(bayes.VariableElimination, "query", query)
    LocationBayes(FRAME).infer([observation()], 0)
    # pgmpy 的虚拟证据内部递归查询必须包含可归一的二元叶节点。
    expanded = [model for model in models if len(model.nodes()) > 1]
    assert expanded
    for model in expanded:
        for cpd in model.get_cpds():
            assert cpd.is_valid_cpd()


@pytest.mark.parametrize("frame", [(), ("a", "a"), ("",), (1,)])
def test_invalid_frames_rejected(frame):
    with pytest.raises(ValueError):
        LocationBayes(frame)


@pytest.mark.parametrize("tau", [0, -1, float("nan"), float("inf")])
def test_invalid_tau_rejected(tau):
    with pytest.raises(ValueError):
        LocationBayes(FRAME, tau=tau)


@pytest.mark.parametrize(
    "prior",
    [
        {},
        {"a": 1},
        dict(zip(FRAME, (0.5, 0.2, 0.2))),
        dict(zip(FRAME, (-0.1, 0.5, 0.6))),
        dict(zip(FRAME, (float("nan"), 0, 1))),
    ],
)
def test_invalid_priors_rejected(prior):
    with pytest.raises(ValueError):
        LocationBayes(FRAME, prior)


def test_invalid_visible_payload_duplicate_id_and_clock_rejected():
    model = LocationBayes(FRAME)
    with pytest.raises(ValueError, match="frame"):
        model.infer([observation(support=frozenset({"other"}))], 0)
    with pytest.raises(ValueError, match="不一致"):
        model.infer([observation(), observation(reliability=0.2)], 0)
    with pytest.raises(ValueError):
        model.infer([], float("nan"))
    with pytest.raises(TypeError):
        model.infer([object()], 0)
    with pytest.raises(TypeError):
        LocationBayes("library")
