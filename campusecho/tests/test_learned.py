"""参数学习手算、多节点联合穷举与测试真值隔离。"""

from dataclasses import replace
from itertools import product
from math import fsum, isfinite

import pytest

from campusecho.data import TIME_OF_DAY, WEATHER, DatasetCase, generate_dataset
from campusecho.evidence import Evidence
from campusecho.learned import MISSING_REPORT, LearnedLocationModel, prepare_evidence


def report(eid="e", source="roommate", support=("library",), observed=10, received=10, origin=None):
    return Evidence(
        eid,
        source,
        origin or eid,
        None if support is None else frozenset(support),
        0.9,
        observed,
        received,
    )


def hand_cases():
    # 两类位置各两例，三个正确单点报告、一个错误报告；所有观测年龄为零。
    return tuple(
        DatasetCase(
            f"case-{index}",
            f"episode-{index}",
            "train",
            1,
            10,
            {"time_of_day": "morning", "weather": "clear"},
            (report(f"e{index}", support=(seen,)),),
            truth,
        )
        for index, (truth, seen) in enumerate(
            (("library", "library"), ("library", "library"), ("club", "library"), ("club", "club"))
        )
    )


def hand_model(**kwargs):
    return LearnedLocationModel.fit(
        hand_cases(), frame=("library", "club"), sources=("roommate",), age_bins=(5,), **kwargs
    )


@pytest.fixture(scope="module")
def campus_model():
    cases = generate_dataset(train_episodes=30, val_episodes=0, test_episodes=0)["train"]
    return LearnedLocationModel.fit(cases)


def test_training_cpd_and_beta_calibration_match_independent_hand_counts():
    model = hand_model(alpha=1)
    assert model.report_distribution("library", "roommate") == pytest.approx(
        {"library": 5 / 8, "club": 5 / 24, MISSING_REPORT: 1 / 6}
    )
    assert model.report_distribution("club", "roommate") == pytest.approx(
        {"library": 5 / 12, "club": 5 / 12, MISSING_REPORT: 1 / 6}
    )
    assert model.source_reliability("roommate") == pytest.approx(4 / 6)
    # fresh 以外没有训练数据，Dirichlet/Beta 回到对称平滑而不是伪造时效曲线。
    assert model.report_distribution("library", "roommate", age=5) == pytest.approx(
        {"library": 1 / 4, "club": 1 / 4, MISSING_REPORT: 1 / 2}
    )
    assert model.source_reliability("roommate", 5) == 0.5
    result = model.infer([report()], 10, {"time_of_day": "morning", "weather": "clear"})
    assert result.probabilities == pytest.approx({"library": 3 / 5, "club": 2 / 5})


def test_missing_probability_is_tied_across_locations_and_no_reply_has_no_information(campus_model):
    for source in campus_model.sources:
        for age in (0, 5, 15):
            rates = [
                campus_model.report_distribution(location, source, age)[MISSING_REPORT]
                for location in campus_model.frame
            ]
            assert max(rates) == min(rates)
            prior = campus_model.infer([], 20, {"weather": "rain"}).probabilities
            weights = {
                location: prior[location] * rates[index]
                for index, location in enumerate(campus_model.frame)
            }
            total = fsum(weights.values())
            assert {
                location: value / total for location, value in weights.items()
            } == pytest.approx(prior)


def enumerate_network(model, records, now, context):
    """独立枚举全部根、位置、年龄和分类报告状态，不调用推理或清洗代码。"""
    parameters = model.export_parameters()
    matching = dict.fromkeys(model.frame, 0.0)
    joint_total = 0.0
    constraints = {item.source_id: item for item in records if item.support is not None}
    channel_states = tuple(product(range(len(model.age_labels)), model.report_states))
    for t, w, location in product(
        range(len(TIME_OF_DAY)), range(len(WEATHER)), range(len(model.frame))
    ):
        root = (
            parameters["time_prior"][t]
            * parameters["weather_prior"][w]
            * parameters["location_cpd"][location][t][w]
        )
        for channels in product(channel_states, repeat=len(model.sources)):
            probability = root
            accepted = all(
                context.get(name, actual) == actual
                for name, actual in (("time_of_day", TIME_OF_DAY[t]), ("weather", WEATHER[w]))
            )
            for source, (age, reported) in zip(model.sources, channels):
                report_index = model.report_states.index(reported)
                probability *= parameters["age_priors"][source][age]
                probability *= parameters["report_cpds"][source][report_index][location][age]
                if source in constraints:
                    item = constraints[source]
                    # 测试固定阈值(5)，独立表达边界，无生产分箱 helper。
                    observed_age = 0 if now - item.observed_at < 5 else 1
                    accepted &= age == observed_age and reported in item.support
            joint_total += probability
            if accepted:
                matching[model.frame[location]] += probability
    assert joint_total == pytest.approx(1, abs=1e-12)
    denominator = fsum(matching.values())
    return {state: value / denominator for state, value in matching.items()}


@pytest.mark.parametrize(
    "context", [{}, {"weather": "rain"}, {"time_of_day": "morning", "weather": "clear"}]
)
@pytest.mark.parametrize("kind", ["single", "composite", "missing"])
def test_exact_ve_matches_full_joint_enumeration_for_missing_roots_ages_and_reports(context, kind):
    model = LearnedLocationModel.fit(
        hand_cases(),
        frame=("library", "club", "canteen"),
        sources=("roommate", "direct"),
        age_bins=(5,),
    )
    support = (
        ("library",) if kind == "single" else ("library", "club") if kind == "composite" else None
    )
    records = [report(support=support), report("direct", "direct", ("canteen",), observed=2)]
    actual = model.infer(records, 10, context)
    assert actual.probabilities == pytest.approx(
        enumerate_network(model, records, 10, context), abs=1e-12
    )
    assert model.network.check_model()


def test_network_has_real_context_and_age_report_nodes_and_ve_is_used(campus_model, monkeypatch):
    from campusecho import learned

    assert len(campus_model.network.nodes()) == 11
    assert set(campus_model.network.get_parents("location")) == {"time_of_day", "weather"}
    for source in campus_model.sources:
        assert set(campus_model.network.get_parents(f"report:{source}")) == {
            "location",
            f"age:{source}",
        }
    original = learned.VariableElimination.query
    called = []

    def query(engine, *args, **kwargs):
        called.append(len(engine.model.nodes()))
        return original(engine, *args, **kwargs)

    monkeypatch.setattr(learned.VariableElimination, "query", query)
    fresh_model = LearnedLocationModel(campus_model.export_parameters())
    fresh_model.infer([report()], 10)
    assert called and called[0] == 11


def test_probability_cache_shares_finite_states_but_rebuilds_evidence_trace(
    campus_model, monkeypatch
):
    from campusecho import learned

    model = LearnedLocationModel(campus_model.export_parameters())
    original = learned.VariableElimination.query
    calls = []

    def query(engine, *args, **kwargs):
        calls.append(1)
        return original(engine, *args, **kwargs)

    monkeypatch.setattr(learned.VariableElimination, "query", query)
    first = model.infer([report("first")], 10)
    second = model.infer([report("second", observed=11, received=11)], 12)
    assert len(calls) == 1
    assert first.probabilities == second.probabilities
    assert first.selected_evidence_ids == ("first",)
    assert second.selected_evidence_ids == ("second",)
    assert first.trace["now"] == 10
    assert second.trace["now"] == 12
    first.probabilities["library"] = 999
    assert model.infer([report("third")], 10).probabilities == second.probabilities


def test_common_preparation_uses_only_visibility_origin_and_source_time_metadata():
    old = report("old", observed=1, received=2)
    new = report("new", support=("club",), observed=3, received=4)
    copy = report("copy", "relay", ("canteen",), observed=3, received=5, origin="new")
    future = report("future", support=("not-in-frame",), observed=2, received=20)
    prepared = prepare_evidence([copy, future, old, new], 10)
    assert prepared.selected == (new,)
    assert {item.evidence_id for item in prepared.discarded} == {"old", "copy"}
    # 故意更改内容仍由元数据选择同一证据，且未来记录不能改写选择。
    changed = replace(new, support=frozenset({"library"}), reliability=0)
    assert prepare_evidence([old, changed, copy], 10).selected == (changed,)


def test_train_only_boundary_rejects_test_before_accessing_truth():
    class Guard:
        split = "test"

        @property
        def truth(self):
            raise AssertionError("不应读取测试 truth")

    with pytest.raises(ValueError, match="train"):
        LearnedLocationModel.fit([Guard()])
    case = replace(hand_cases()[0], split="val")
    with pytest.raises(ValueError, match="train"):
        LearnedLocationModel.fit([case])


def test_test_truth_cannot_enter_infer_and_does_not_change_projection(campus_model):
    case = generate_dataset(train_episodes=0, val_episodes=0, test_episodes=1)["test"][0]
    before = campus_model.infer(*case.inference_inputs())
    alternate = next(state for state in campus_model.frame if state != case.truth)
    assert campus_model.infer(*replace(case, truth=alternate).inference_inputs()) == before
    with pytest.raises(TypeError):
        campus_model.infer([], 10, truth="library")
    with pytest.raises(ValueError, match="context"):
        campus_model.infer([], 10, {"truth": "library"})


def test_missing_vacuous_zero_and_unknown_source_are_marginalized(campus_model):
    context = {"weather": "rain"}
    prior = campus_model.infer([], 10, context).probabilities
    records = [
        report("missing", support=None),
        report("vacuous", "clubmate", campus_model.frame),
        replace(report("zero", "camera"), reliability=0),
        report("unknown", "unseen-source"),
    ]
    result = campus_model.infer(records, 10, context)
    assert result.probabilities == prior
    assert {row["status"] for row in result.trace["observations"]} == {
        "missing",
        "vacuous",
        "zero_reliability",
        "unknown_source",
    }


def test_composite_inference_never_leaves_virtual_nodes_or_stale_observations(campus_model):
    prior = campus_model.infer([], 10)
    record = report(support=("library", "club"))
    first = campus_model.infer([record], 10)
    assert campus_model.infer([record], 10) == first
    assert campus_model.infer([], 10) == prior
    assert len(campus_model.network.nodes()) == 11


def test_smoothed_complete_disagreement_is_finite_and_explicit(campus_model):
    records = [
        replace(report(), reliability=1),
        replace(report("other", "direct", ("club",)), reliability=1),
    ]
    result = campus_model.infer(records, 10)
    assert result.trace["conflicting_reports"] is True
    assert "Dirichlet" in result.trace["conflict_policy"]
    assert all(isfinite(value) and value > 0 for value in result.probabilities.values())
    assert fsum(result.probabilities.values()) == pytest.approx(1)
    assert result.trace["training_id"] == campus_model.training_id
    assert result.trace["alpha"] == campus_model.alpha
    assert set(result.trace["source_calibration"]) == set(campus_model.sources)


def test_save_load_and_exports_are_detached(campus_model, tmp_path):
    target = tmp_path / "model.json"
    campus_model.save(target)
    restored = LearnedLocationModel.load(target)
    records = [report(support=("library", "club"))]
    assert restored.infer(records, 10, {"weather": "rain"}) == campus_model.infer(
        records, 10, {"weather": "rain"}
    )
    params = restored.export_parameters()
    params["report_cpds"]["roommate"][0][0][0] = 999
    assert restored.export_parameters() != params
    distribution = restored.report_distribution("library", "direct")
    distribution["library"] = 999
    assert sum(restored.report_distribution("library", "direct").values()) == pytest.approx(1)


@pytest.mark.parametrize("alpha", [0, -1, float("nan")])
def test_invalid_smoothing_rejected(alpha):
    with pytest.raises(ValueError):
        hand_model(alpha=alpha)


def test_bad_cpd_missing_source_and_invalid_age_rejected(campus_model):
    values = campus_model.export_parameters()
    values["location_cpd"][0][0][0] = 0
    with pytest.raises(ValueError, match="CPD"):
        LearnedLocationModel(values)
    with pytest.raises(ValueError, match="来源"):
        campus_model.source_reliability("unknown")
    with pytest.raises(ValueError, match="age"):
        campus_model.report_distribution("library", "direct", -1)
