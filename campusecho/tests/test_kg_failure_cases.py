"""Regression checks for the report-three boundary and failure cases."""

from __future__ import annotations

import json
from pathlib import Path

from campusecho.kg_data import load_kg_data
from campusecho.kg_experiment import ExperimentConfig, run_search
from campusecho.kg_hybrid import HybridConfig, hybrid_search
from campusecho.kg_search import SearchConfig
from campusecho.llm_gateway import KGActionEvaluation

PROJECT = Path(__file__).resolve().parents[1]
FROZEN = PROJECT / "artifacts/kg/formal_test_20261118"
GA_WEIGHTS = (0.663013285672417, 0.06281547621309151, 0.0778998278709586, 0.19627141024353287)


def _data():
    return load_kg_data(PROJECT / "data/kg", verify=True)


def test_alias_case_paths_match_frozen_records_and_report():
    rows = [
        json.loads(line)
        for line in (FROZEN / "records.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    target = [row for row in rows if row["question_id"] == "robust:campus-cloud_sail:000"]
    by_method = {row["method"]: row for row in target}
    expected = ["club:02:0", "person:02:00", "person:02:10"]
    for method in ("bfs", "hand_astar", "mcts", "ga_astar_classifier"):
        assert by_method[method]["predicted_paths"] == [expected]
    assert by_method["ga_astar"]["predicted_paths"] == [
        ["club:02:0", "person:02:03", "person:02:02"]
    ]
    report = (PROJECT / "docs/report3.md").read_text(encoding="utf-8")
    assert "`club:02:0 → person:02:00 → person:02:10`" in report
    assert "可采纳性（Admissibility）遭到破坏" not in report


def test_low_budget_case_is_a_real_miss_for_four_methods():
    data = _data()
    question = next(
        row for row in data.questions["core"] if row.question_id == "core:campus-cloud_sail:017"
    )
    config = ExperimentConfig(
        split="test",
        limit=1,
        max_expansions=2,
        mcts_simulations=10,
        rollout_depth=8,
        methods=("bfs", "hand_astar", "ga_astar", "mcts", "ga_astar_classifier"),
    )
    runs = {
        method: run_search(question, data.graph, method, config=config, ga_weights=GA_WEIGHTS)
        for method in config.methods
    }
    for method in ("bfs", "hand_astar", "ga_astar", "ga_astar_classifier"):
        assert runs[method].paths == ()
        assert "budget_exhausted" in runs[method].stop_reasons
    assert runs["mcts"].paths
    assert runs["mcts"].stop_reasons[-1] == "goal_found"


def test_llm_hallucination_degrades_and_local_search_survives():
    data = _data()
    question = next(
        row for row in data.questions["core"] if row.question_id == "core:campus-star_bridge:011"
    )

    class DegradedGateway:
        def evaluate_kg_actions(self, *_args, **_kwargs):
            return KGActionEvaluation("degraded", (), "invented action_id")

    result = hybrid_search(
        data,
        question,
        HybridConfig(mode="llm", weights=GA_WEIGHTS),
        gateway=DegradedGateway(),
        search_config=SearchConfig(
            max_expansions=32,
            max_candidate_checks=256,
            max_solutions=1,
            max_depth=question.max_hops,
            mcts_simulations=24,
            rollout_depth=8,
            seed=20261118,
        ),
    )
    assert result.llm_status == "degraded"
    assert result.llm_scored_actions == 0
    assert result.search.success
    assert len(result.search.solutions) == 1
