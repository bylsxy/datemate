"""Checks for the fixed-subset LLM-A* frozen comparison artifacts."""

from __future__ import annotations

import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]


def _summary(name: str):
    return json.loads(
        (PROJECT / "artifacts/kg" / name / "summary.json").read_text(encoding="utf-8")
    )


def test_llm_comparison_has_fixed_subset_and_expected_methods():
    summary = _summary("llm_compare_20261118")
    assert summary["status"] == "complete"
    assert summary["limit"] == 12
    assert len(summary["question_ids"]) == 12
    assert set(summary["methods"]) == {"A*", "LLM-A*", "LLM-A*-wrong"}
    assert "qwen2.5-1.5b" in summary["model"].lower()
    assert summary["methods"]["LLM-A*"]["success_rate"] == 1.0
    assert (
        summary["methods"]["LLM-A*"]["mean_expanded_nodes"]
        < summary["methods"]["A*"]["mean_expanded_nodes"]
    )
    assert (
        summary["methods"]["LLM-A*-wrong"]["mean_expanded_nodes"]
        > summary["methods"]["LLM-A*"]["mean_expanded_nodes"]
    )


def test_budget_constrained_llm_comparison_shows_double_edged_risk():
    summary = _summary("llm_compare_budget_20261118")
    assert summary["limit"] == 12
    assert summary["methods"]["LLM-A*"]["success_rate"] == 0.8333333333333334
    assert summary["methods"]["A*"]["success_rate"] == 0.6666666666666666
    assert summary["methods"]["LLM-A*-wrong"]["success_rate"] == 0.6666666666666666
