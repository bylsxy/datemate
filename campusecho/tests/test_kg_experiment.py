"""正式知识图谱对比实验的隔离、指标、确定性与输出契约。"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import pytest

from campusecho.kg_data import AnswerLabel, KGData
from campusecho.kg_experiment import (
    ABLATION_LABELS,
    METHODS,
    ExperimentConfig,
    LLMScoreRequest,
    _classifier_samples,
    fit_experiment_parameters,
    run_experiment,
    score_prediction,
    stratified_sample,
    write_experiment_outputs,
)

PROJECT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT / "data/kg"


@pytest.fixture(scope="module")
def real_data():
    from campusecho.kg_data import load_kg_data

    return load_kg_data(DATA_DIR, verify=True)


def _small_config(**overrides):
    values = {
        "split": "test",
        "limit": 5,
        "fit_limit": 4,
        "methods": METHODS,
        "seed": 41,
        "llm_subset_limit": 3,
        "max_expansions": 5_000,
        "mcts_simulations": 20,
        "rollout_depth": 6,
        "ga_population_size": 4,
        "ga_generations": 1,
        "ga_seeds": (41,),
        "classifier_epochs": 30,
        "classifier_prefix_limit": 2_000,
    }
    values.update(overrides)
    return ExperimentConfig(**values)


def _label(question_id: str, path: tuple[str, ...] | None) -> AnswerLabel:
    paths = () if path is None else (path,)
    return AnswerLabel(
        question_id,
        () if not paths else (path[-1],),
        paths,
        () if not paths else (len(path) - 1,),
        bool(paths),
    )


def _replace_labels(data: KGData, **labels: AnswerLabel) -> KGData:
    core = tuple(labels.get(label.question_id, label) for label in data.labels["core"])
    robust = tuple(labels.get(label.question_id, label) for label in data.labels["robust"])
    return KGData(data.graph, data.questions, {"core": core, "robust": robust}, data.manifest)


def test_answer_leakage_isolation_and_llm_callback_payload(real_data):
    observed: list[LLMScoreRequest] = []

    def scorer(request: LLMScoreRequest):
        observed.append(request)
        return {"score": 0.75, "note": "public-only"}

    result = run_experiment(
        real_data,
        _small_config(methods=("bfs",), include_private_labels=False),
        data_dir=DATA_DIR,
        llm_scorer=scorer,
    )

    assert result.records
    assert all("gold_answers" not in row for row in result.records)
    assert all("gold_paths" not in row for row in result.records)
    assert observed
    assert all(not hasattr(request.question, "answers") for request in observed)
    assert all(not hasattr(request.question, "paths") for request in observed)
    assert all("gold" not in request.__dataclass_fields__ for request in observed)
    assert result.summary["fit"]["metadata"]["test_used_for_fit"] is False
    assert result.summary["fit"]["metadata"]["frozen_before_test"] is True
    assert "classifier_fallback_reason" in result.summary["fit"]["metadata"]
    assert "ga_fallback_reason" in result.summary["fit"]["metadata"]
    calibration = result.summary["fit"]["metadata"]["classifier_calibration"]
    assert calibration["sample_count"] >= 0
    assert calibration["threshold"] == result.summary["fit"]["classifier_threshold"]
    assert calibration["source"] == result.summary["fit"]["metadata"][
        "classifier_threshold_source"
    ]
    assert result.summary["fit"]["metadata"]["classifier_threshold_source"] in {
        "val_balanced_accuracy",
        "fallback:val_has_one_class",
    }
    assert result.summary["fit"]["metadata"]["fit_splits"] == ["train", "val"]
    assert result.summary["llm_subset"]["question_ids"] == list(
        dict.fromkeys(result.summary["llm_subset"]["question_ids"])
    )


def test_fit_ignores_test_label_mutation(real_data):
    first = fit_experiment_parameters(real_data, _small_config())
    test_ids = {
        question.question_id
        for set_name in ("core", "robust")
        for question in real_data.public_questions(set_name)
        if question.split == "test"
    }
    mutated = {
        question_id: _label(question_id, None)
        for question_id in test_ids
    }
    changed = _replace_labels(real_data, **mutated)
    second = fit_experiment_parameters(changed, _small_config())

    assert first.ga_weights == second.ga_weights
    assert first.classifier_threshold == second.classifier_threshold
    assert first.classifier.export_parameters() == second.classifier.export_parameters()


def test_classifier_training_contains_failed_prefixes_and_excludes_test(real_data):
    fit_questions = tuple(
        question
        for set_name in ("core", "robust")
        for question in real_data.public_questions(set_name)
        if question.split in {"train", "val"}
    )[:6]
    labels = {
        label.question_id: label
        for set_name in ("core", "robust")
        for label in real_data.private_labels(set_name)
    }
    train_samples, val_samples = _classifier_samples(
        real_data.graph,
        fit_questions,
        labels,
        _small_config(classifier_prefix_limit=2_000),
    )
    samples = (*train_samples, *val_samples)
    assert samples
    assert {sample.label for sample in samples} == {False, True}
    assert any(sample.label is False for sample in train_samples)
    assert any(sample.label is True for sample in train_samples)
    assert {sample.split for sample in samples} <= {"train", "val"}
    assert all(sample.split != "test" for sample in samples)


def test_score_prediction_metrics_and_failure_reasons():
    solved = _label("q", ("a", "b", "c"))
    exact = score_prediction((("a", "b", "c"),), solved)
    assert exact["answer_correct"] is True
    assert exact["path_valid"] is True
    assert exact["path_complete"] is True
    assert exact["success"] is True
    assert exact["failure_reason"] is None
    assert exact["answer_precision"] == exact["answer_recall"] == 1.0

    partial = score_prediction((("a", "b", "x"),), solved)
    assert partial["answer_correct"] is False
    assert partial["path_valid"] is False
    assert partial["success"] is False
    assert partial["failure_reason"] == "answer_and_path_mismatch"

    assert score_prediction((("a", "b", "c"),), _label("single", ("a", "b", "c")))[
        "success"
    ] is True

    two_paths = AnswerLabel(
        "two",
        ("c", "d"),
        (("a", "b", "c"), ("a", "x", "d")),
        (2,),
        True,
    )
    incomplete = score_prediction((("a", "b", "c"),), two_paths)
    assert incomplete["answer_correct"] is True
    assert incomplete["path_valid"] is True
    assert incomplete["path_complete"] is False
    assert incomplete["success"] is True
    assert incomplete["failure_reason"] is None

    superset = score_prediction(
        (("a", "b", "c"), ("a", "x", "d"), ("a", "y", "e")),
        two_paths,
    )
    assert superset["failure_reason"] == "invalid_path"

    no_solution = score_prediction((), solved)
    assert no_solution["failure_reason"] == "no_solution"
    assert no_solution["path_valid"] is False

    unsolvable = _label("u", None)
    assert score_prediction((), unsolvable)["success"] is True
    assert score_prediction((("a", "b", "c"),), unsolvable)["failure_reason"] == (
        "answer_and_path_mismatch"
    )


def test_stratified_sample_is_fixed_and_covers_available_strata(real_data):
    questions = tuple(
        question
        for set_name in ("core", "robust")
        for question in real_data.public_questions(set_name)
        if question.split == "test"
    )
    first = stratified_sample(questions, limit=20, seed=7)
    second = stratified_sample(reversed(questions), limit=20, seed=7)
    assert first == second
    assert len(first) == 20
    assert len({question.question_id for question in first}) == 20
    assert first == tuple(sorted(first, key=lambda q: (q.split, q.question_id)))
    assert {question.kind for question in first} == {question.kind for question in questions}
    assert stratified_sample(questions, limit=None, seed=7) == tuple(
        sorted(questions, key=lambda q: (q.split, q.question_id))
    )


def test_experiment_is_deterministic_and_all_methods_share_questions(real_data):
    config = _small_config(
        limit=4,
        fit_limit=4,
        methods=("bfs", "hand_astar", "ga_astar", "mcts", "ga_astar_classifier"),
        llm_subset_limit=2,
    )
    first = run_experiment(real_data, config, data_dir=DATA_DIR)
    second = run_experiment(real_data, config, data_dir=DATA_DIR)

    def stable(rows):
        return [
            {
                key: value
                for key, value in row.items()
                if key not in {"elapsed_seconds", "search_elapsed_seconds"}
            }
            for row in rows
        ]

    assert stable(first.records) == stable(second.records)
    assert first.parameters["ga_weights"] == second.parameters["ga_weights"]
    assert first.parameters["classifier"] == second.parameters["classifier"]
    by_method = {
        method: {row["question_id"] for row in first.records if row["method"] == method}
        for method in config.methods
    }
    assert len({frozenset(ids) for ids in by_method.values()}) == 1
    assert all(len(ids) == 4 for ids in by_method.values())
    assert first.summary["llm_subset"]["question_ids"] == second.summary["llm_subset"][
        "question_ids"
    ]
    assert len(first.summary["llm_subset"]["question_ids"]) <= 60


def test_bfs_uses_only_actual_solution_and_tracks_completion_separately(real_data):
    result = run_experiment(
        real_data,
        _small_config(limit=5, fit_limit=4, methods=("bfs",)),
        data_dir=DATA_DIR,
    )
    assert result.summary["aggregates"]["test"]["bfs"]["answer_accuracy"] == 1.0
    assert result.summary["aggregates"]["test"]["bfs"]["success_rate"] == 1.0
    assert all(
        row["predicted_path_count"] <= row["max_hops"] - row["min_hops"] + 1
        for row in result.records
    )
    assert result.summary["aggregates"]["test"]["bfs"]["path_valid_rate"] == 1.0


def test_ablation_labels_and_output_schema(real_data, tmp_path):
    result = run_experiment(
        real_data,
        _small_config(limit=2, fit_limit=2, llm_subset_limit=1),
        data_dir=DATA_DIR,
    )
    output = write_experiment_outputs(result, tmp_path / "frozen")
    expected = {
        "summary.json",
        "config.json",
        "fingerprints.json",
        "parameters.json",
        "protocol.json",
        "metrics.csv",
        "records.jsonl",
        "records.csv",
        "report_table.json",
        "report_table.md",
        "freeze_manifest.json",
    }
    assert {path.name for path in output.iterdir()} == expected

    summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
    assert summary["schema_version"] == 1
    assert summary["status"] == "complete"
    assert summary["method_order"] == list(METHODS)
    assert len(summary["question_ids"]) == 2
    assert summary["protocol"]["success_definition"] == "answer_correct and path_valid"
    assert "max_solutions=1" in summary["protocol"]["search_solution_policy"]
    assert "failed branches" in summary["protocol"]["classifier_training"]
    assert set(summary["aggregates"]["test"]) == set(METHODS)
    assert summary["ablation_labels"] == ABLATION_LABELS
    assert summary["ablation_labels"]["ga_astar_classifier"]["ablation_of"] == "ga_astar"
    assert summary["ablation_labels"]["ga_astar"]["ablation_of"] is None
    assert set(summary["fingerprints"]["data"]) == {
        "graph.json",
        "questions_public.jsonl",
        "answers_private.jsonl",
        "manifest.json",
    }
    assert all(len(item["sha256"]) == 64 for item in summary["fingerprints"]["data"].values())
    assert summary["fingerprints"]["source_scope"]
    assert summary["fingerprints"]["data_scope"]
    assert len(summary["fingerprint_digest"]) == 64

    rows = [
        json.loads(line)
        for line in (output / "records.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    required = {
        "question_id",
        "split",
        "method",
        "answer_correct",
        "path_valid",
        "path_complete",
        "success",
        "expanded_nodes",
        "candidate_checks",
        "reasoning_steps",
        "redundant_ratio",
        "elapsed_seconds",
        "failure_reason",
        "llm_score",
    }
    assert all(required <= set(row) for row in rows)
    with (output / "metrics.csv").open(encoding="utf-8", newline="") as handle:
        metric_rows = list(csv.DictReader(handle))
    assert metric_rows
    assert {"split", "method", "answer_accuracy", "success_rate"} <= set(metric_rows[0])
    report = json.loads((output / "report_table.json").read_text(encoding="utf-8"))
    assert report["schema_version"] == 1
    assert report["rows"]
    assert {"method", "method_label", "success_rate"} <= set(report["rows"][0])
    freeze = json.loads((output / "freeze_manifest.json").read_text(encoding="utf-8"))
    for name, entry in freeze["files"].items():
        payload = (output / name).read_bytes()
        assert hashlib.sha256(payload).hexdigest() == entry["sha256"]
        assert len(payload) == entry["bytes"]
    with pytest.raises(FileExistsError):
        write_experiment_outputs(result, output)


def test_empty_llm_subset_and_private_label_opt_in(real_data):
    result = run_experiment(
        real_data,
        _small_config(
            limit=2,
            fit_limit=2,
            llm_subset_limit=0,
            include_private_labels=True,
        ),
        data_dir=DATA_DIR,
    )
    assert result.summary["llm_subset"]["question_ids"] == []
    assert all("gold_answers" in row for row in result.records)


def test_llm_callback_errors_are_recorded_without_changing_search(real_data):
    def broken(_request):
        raise RuntimeError("offline")

    result = run_experiment(
        real_data,
        _small_config(
            limit=1,
            fit_limit=2,
            methods=("bfs",),
            llm_subset_limit=1,
        ),
        data_dir=DATA_DIR,
        llm_scorer=broken,
    )
    assert result.records[0]["llm_score"] is None
    assert result.records[0]["llm_error"] == "RuntimeError: offline"
    assert "error" not in result.records[0]


def test_llm_boolean_score_is_rejected_as_non_numeric(real_data):
    result = run_experiment(
        real_data,
        _small_config(limit=1, fit_limit=2, methods=("bfs",), llm_subset_limit=1),
        data_dir=DATA_DIR,
        llm_scorer=lambda _request: True,
    )
    assert result.records[0]["llm_score"] is None
    assert result.records[0]["llm_error"] == "LLM 分数不能是 bool"


def test_config_rejects_oversized_llm_subset_and_duplicate_methods():
    with pytest.raises(ValueError, match="60"):
        ExperimentConfig(llm_subset_limit=61)
    with pytest.raises(ValueError, match="重复"):
        ExperimentConfig(methods=("bfs", "bfs"))
    with pytest.raises(ValueError, match="未知"):
        ExperimentConfig(methods=("unknown",))
