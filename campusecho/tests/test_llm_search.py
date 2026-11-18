"""Tests for the LLM-A* adapter and reward fault injection."""

from __future__ import annotations

from campusecho.kg_data import load_kg_data
from campusecho.llm_gateway import KGActionEvaluation, KGActionScore
from campusecho.llm_search import run_llm_astar


def _data():
    return load_kg_data("data/kg", verify=False)


def _question(data):
    return next(
        row
        for row in data.questions["core"]
        if row.question_id == "core:campus-star_bridge:011"
    )


class GoodGateway:
    def __init__(self):
        self.calls = 0

    def evaluate_kg_actions(self, *args, **kwargs):
        self.calls += 1
        candidates = args[3]
        return KGActionEvaluation(
            "ok",
            tuple(
                KGActionScore(candidate.action_id, 0.5, True, "相关")
                for candidate in candidates
            ),
        )


class DegradedGateway:
    def evaluate_kg_actions(self, *args, **kwargs):
        return KGActionEvaluation("degraded", (), "invalid")


class RankingGateway:
    def __init__(self):
        self.calls = 0

    def chat(self, messages, **kwargs):
        self.calls += 1

        class Result:
            status = "ok"
            content = '{"action_id":"a0"}'
            error = None

        return Result()


def test_llm_astar_calls_model_and_returns_a_valid_search():
    data = _data()
    question = _question(data)
    gateway = GoodGateway()
    result = run_llm_astar(
        data, question, gateway, max_llm_calls=3, scorer_mode="batch"
    )
    assert gateway.calls
    assert result.usage.calls
    assert result.usage.ok_calls
    assert result.search.paths
    assert result.usage.status == "ok"


def test_llm_astar_degrades_to_base_search_when_model_is_invalid():
    data = _data()
    question = _question(data)
    router = DegradedGateway()
    result = run_llm_astar(
        data, question, router, max_llm_calls=3, scorer_mode="batch"
    )
    assert result.usage.degraded_calls
    assert result.usage.status == "degraded"
    assert result.search.paths


def test_llm_wrong_reward_is_a_controlled_run_through_same_scorer():
    data = _data()
    question = _question(data)
    gateway = GoodGateway()
    result = run_llm_astar(
        data,
        question,
        gateway,
        max_llm_calls=3,
        corruption="flip",
        scorer_mode="batch",
    )
    assert result.usage.calls
    assert result.search.paths


def test_ranking_llm_path_is_supported_and_uses_opaque_action_ids():
    data = _data()
    question = _question(data)
    gateway = RankingGateway()
    result = run_llm_astar(
        data,
        question,
        gateway,
        max_llm_calls=3,
        model="local-test-model",
    )
    assert gateway.calls
    assert result.usage.ok_calls
    assert result.search.paths
