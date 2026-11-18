"""有限状态等价性、共享对照及轨迹统计契约。"""

import json
import runpy
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from campusecho.data import generate_dataset
from campusecho.evidence import Evidence
from campusecho.learned import LearnedLocationModel, prepare_evidence
from campusecho.research import (
    FiniteStateAdapter,
    ResearchConfig,
    episode_subset,
    evaluate,
    paired_comparisons,
    perturb,
    resume_dynamic,
    summarize,
    verify_adapter,
)


@pytest.fixture(scope="module")
def data():
    return generate_dataset(train_episodes=20, val_episodes=4, test_episodes=4)


@pytest.fixture(scope="module")
def model(data):
    return FiniteStateAdapter(LearnedLocationModel.fit(data["train"]))


SELECTED = {"discount_scale": 1.0, "confidence_threshold": 0.55, "conflict_threshold": 0.6}


def test_exact_cpd_adapter_matches_pgmpy(data, model):
    assert verify_adapter(model, data["val"], count=6)["passed"]


def test_set_missing_future_and_duplicate_adapter(model):
    evidence = (
        Evidence("a", "direct", "one", {"club", "library"}, 0.9, 8, 9),
        Evidence("b", "camera", "two", None, 0.9, 9, 10),
        Evidence("future", "clubmate", "three", {"club"}, 0.9, 12, 12),
    )
    for context in ({}, {"time_of_day": "evening", "weather": "rain"}):
        fast = model.infer(evidence, 10, context).probabilities
        exact = model.model.infer(evidence, 10, context).probabilities
        assert max(abs(fast[s] - exact[s]) for s in fast) < 1e-10


def test_cache_excludes_truth_and_case_id(data, model):
    case = data["test"][0]
    before = model.hits
    p = model.infer(*case.inference_inputs()).probabilities
    other = replace(
        case, truth=next(s for s in model.frame if s != case.truth), case_id="different"
    )
    assert model.infer(*other.inference_inputs()).probabilities == p
    assert model.hits > before


def test_primary_standard_dedup_are_equal(data, model):
    rows = evaluate(
        data["test"],
        ["standard_ds", "dedup_ds"],
        model,
        SELECTED,
        experiment="test",
        condition="base",
    )
    for left, right in zip(rows[::2], rows[1::2]):
        assert left["probabilities"] == right["probabilities"]
        assert left["selected_ids"] == right["selected_ids"]


def test_copy_preprocessing_invariance(data, model):
    case = data["test"][0]
    base = perturb((case,), "copy", 1, 3)[0]
    many = perturb((case,), "copy", 10, 3)[0]
    a = model.infer(*base.inference_inputs()).probabilities
    b = model.infer(*many.inference_inputs()).probabilities
    assert a == b
    assert len(prepare_evidence(many.evidence, many.now).selected) == len(
        prepare_evidence(base.evidence, base.now).selected
    )


def test_cluster_bootstrap_and_paired_identity(data, model):
    rows = evaluate(
        data["test"],
        ["strong_bayes", "standard_ds"],
        model,
        SELECTED,
        experiment="test",
        condition="base",
    )
    one = [r for r in rows if r["method"] == "strong_bayes"]
    stats = summarize(one, bootstrap=50)
    assert stats["episodes"] == 4 and stats["snapshots"] == 12
    # 在每一轨迹内部完全复制快照不会增加独立样本数，也不收窄 CI。
    doubled = [*one, *one]
    assert summarize(doubled, bootstrap=50)["accuracy_ci95"] == stats["accuracy_ci95"]
    same = [{**r, "method": "copy"} for r in one]
    comparison = paired_comparisons(one + same, ResearchConfig(bootstrap=50))[0]
    assert comparison["accuracy_difference_ci95"] == [0, 0]
    assert comparison["brier_difference_ci95"] == [0, 0]


def test_subsets_keep_all_snapshots(data):
    subset = episode_subset(data["test"], 2)
    assert len(subset) == 6 and len({c.episode_id for c in subset}) == 2


def test_rule_abstains_without_reports(data, model):
    case = replace(data["test"][0], evidence=())
    row = evaluate((case,), ["rule"], model, SELECTED, experiment="empty", condition="none")[0]
    assert row["prediction"] is None and not row["covered"]
    assert sum(row["probabilities"].values()) == pytest.approx(1)
    assert np.isfinite(row["brier"])


def test_inference_adapter_rejects_unknown_context(model):
    with pytest.raises(ValueError):
        model.infer((), 0, {"truth": "club"})


def test_formal_dynamic_requires_explicit_approval(tmp_path):
    approval = tmp_path / "approval.json"
    approval.write_text(json.dumps({"approval": "pending"}), encoding="utf-8")
    with pytest.raises(ValueError, match="DYNAMIC_APPROVED"):
        resume_dynamic(tmp_path, approval_file=approval)
    assert not (tmp_path / "dynamic_raw.jsonl").exists()


def test_formal_dynamic_refuses_source_hash_mismatch(tmp_path):
    approval = tmp_path / "approval.json"
    approval.write_text(
        json.dumps(
            {"approval": "DYNAMIC_APPROVED", "world_sha256": "wrong", "policy_sha256": "wrong"}
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="hash"):
        resume_dynamic(tmp_path, approval_file=approval)
    assert not (tmp_path / "dynamic_raw.jsonl").exists()


@pytest.fixture(scope="module")
def supplemental():
    return runpy.run_path(str(Path(__file__).resolve().parents[1] / "tools/run_supplemental.py"))


def test_supplemental_paired_difference_preserves_direction_and_unit(supplemental):
    rows = [
        {"episode_id": str(i), "conflict_threshold": level, "accuracy": value}
        for i in range(4)
        for level, value in ((0.35, 0.25), (0.85, 0.75))
    ]
    result = supplemental["pair_differences"](
        rows,
        "conflict_threshold",
        [0.35, 0.85],
        0.85,
        ["accuracy"],
        {"bootstrap_replicates": 50, "seed": 5},
    )[0]
    assert result["episodes"] == 4 and result["bootstrap_unit"] == "paired episode"
    assert result["accuracy"] == -0.5
    assert result["accuracy_ci95"] == [-0.5, -0.5]


def test_supplemental_rejects_unpaired_seed_sets(supplemental):
    with pytest.raises(AssertionError):
        supplemental["pair_differences"](
            [
                {"episode_id": "a", "query_cost": 0, "success": 1},
                {"episode_id": "b", "query_cost": 2, "success": 1},
            ],
            "query_cost",
            [0, 2],
            2,
            ["success"],
            {"bootstrap_replicates": 50, "seed": 5},
        )


def test_supplemental_same_values_have_zero_sampling_width(supplemental):
    stats = supplemental["scalar_summary"](
        [{"query_time_minutes": 2, "query_objective_loss_units": 0} for _ in range(5)],
        ["query_time_minutes", "query_objective_loss_units"],
        50,
        5,
    )
    assert stats["query_time_minutes_ci95"] == [2, 2]
    assert stats["query_objective_loss_units_ci95"] == [0, 0]


@pytest.fixture(scope="module")
def ablation():
    return runpy.run_path(str(Path(__file__).resolve().parents[1] / "tools/run_ablation.py"))


def test_index_only_matches_independent_grounding_oracle(ablation):
    from campusecho.logic import Atom, Rule, Var, forward_chain

    x, y, z = Var("x"), Var("y"), Var("z")
    facts = {Atom("edge", ("a", "b")), Atom("edge", ("b", "c")), Atom("edge", ("c", "a"))}
    rules = [
        Rule("base", Atom("path", (x, y)), (Atom("edge", (x, y)),)),
        Rule("nonlinear", Atom("path", (x, z)), (Atom("path", (x, y)), Atom("path", (y, z)))),
        Rule("unconditional", Atom("ready")),
    ]
    oracle = ablation["grounded_oracle"](facts, rules, ["a", "b", "c"])
    assert ablation["index_only"](facts, rules).facts == oracle
    assert forward_chain(facts, rules, "naive").facts == oracle
    assert forward_chain(facts, rules, "semi_naive").facts == oracle


def test_index_only_separates_index_gain_from_delta_gain(ablation):
    from campusecho.logic import forward_chain

    facts, rules, expected = ablation["rule_fixture"]("synthetic_facts", 100)
    naive = forward_chain(facts, rules, "naive")
    indexed = ablation["index_only"](facts, rules)
    delta = forward_chain(facts, rules, "semi_naive")
    assert naive.facts == indexed.facts == delta.facts == expected
    assert indexed.metrics.rule_evaluations == naive.metrics.rule_evaluations
    assert indexed.metrics.rule_matches == naive.metrics.rule_matches
    assert indexed.metrics.candidate_checks < naive.metrics.candidate_checks
    assert delta.metrics.rule_matches < indexed.metrics.rule_matches


def test_hidden_dependence_preserves_marginals_and_unique_origins(ablation):
    cases = generate_dataset(seed=20261105, train_episodes=0, val_episodes=0, test_episodes=20)[
        "test"
    ]
    for level in (0, 0.25, 0.5, 0.75, 1):
        transformed, audit = ablation["correlation_cases"](cases, level)
        assert len({r["episode_id"] for r in audit if r["hidden_shared_channel"]}) == int(
            20 * level
        )
        for source in ablation["SOURCES"]:
            assert (
                sum(
                    c["is_error"]
                    for row in audit
                    for c in row["channels"]
                    if c["source_id"] == source
                )
                == 12
            )
        assert all(len({e.origin_id for e in c.evidence}) == 4 for c in transformed)
        if level == 1:
            assert all(len({c["support"] for c in row["channels"]}) == 1 for row in audit)


def test_calibration_bootstrap_clusters_snapshots(ablation):
    rows = [
        {
            "episode_id": str(i),
            "truth": "a" if i < 4 else "b",
            "probabilities": {"a": 0.8, "b": 0.2},
        }
        for i in range(5)
    ]
    stats = ablation["calibration"](rows, bootstrap=50)
    duplicated = ablation["calibration"](rows + rows, bootstrap=50)
    assert stats["ece10"] == pytest.approx(0)
    assert stats["mean_confidence"] == pytest.approx(0.8)
    assert stats["ece10_ci95"] == duplicated["ece10_ci95"]
