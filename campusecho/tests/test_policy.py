from dataclasses import replace
from types import SimpleNamespace

import pytest

from campusecho.policy import PolicyConfig, choose_action, observed_location_distribution
from campusecho.world import FRAME, Action, observe, scenario, step


class ToyModel:
    """独立有限实验：完美信息有价值，高查询成本会抵消它。"""

    def infer(self, evidence, now, context=None):
        replies = [e for e in evidence if e.evidence_id.startswith("voi:")]
        probabilities = dict.fromkeys(sorted(FRAME), 1 / len(FRAME))
        if replies:
            report = next(iter(replies[-1].support))
            probabilities = {s: float(s == report) for s in FRAME}
        return SimpleNamespace(probabilities=probabilities)

    def source_reliability(self, source, age=0):
        return 0.85

    def report_distribution(self, location, source, age=0, context=None):
        return {**{s: (0.95 if s == location else 0.0) for s in FRAME}, "__missing__": 0.05}


def test_perfect_information_can_be_selected_with_positive_value():
    decision = choose_action(observe(scenario("mission"), "player"), ToyModel())
    assert decision.action.kind == "ask"
    assert decision.information_value > 0
    assert decision.alternatives


def test_expensive_query_is_rejected():
    decision = choose_action(
        observe(scenario("mission"), "player"), ToyModel(), config=PolicyConfig(query_cost=100)
    )
    assert decision.action.kind != "ask"
    assert decision.information_value == 0


def test_query_budget_zero_and_terminal_state():
    view = observe(scenario("mission"), "player")
    assert choose_action(view, ToyModel(), config=PolicyConfig(max_queries=0)).action.kind != "ask"
    done = replace(view, task=replace(view.task, status="missed", settled_at=view.task.deadline))
    assert choose_action(done, ToyModel()).action is None


def test_same_public_view_same_decision():
    world = scenario("mission")
    hidden = replace(world, seed=999999)
    assert observe(world, "player") == observe(hidden, "player")
    assert choose_action(observe(world, "player"), ToyModel()) == choose_action(
        observe(hidden, "player"), ToyModel()
    )


def test_rule_known_action_precedes_statistical_suggestions():
    world = scenario("mission")
    world = step(world, Action("move", target="walkway", minutes=4))
    world = step(world, Action("move", target="club", minutes=4))
    decision = choose_action(observe(world, "player"), None)
    assert decision.action.kind == "inform"
    world = step(world, decision.action)
    assert choose_action(observe(world, "player"), None).action.kind == "confirm"


def test_non_mission_fixture_and_unknown_strategy():
    assert choose_action(observe(scenario(), "player"), ToyModel()).action is None
    with pytest.raises(ValueError):
        choose_action(observe(scenario("mission"), "player"), ToyModel(), strategy="unknown")


def test_current_empty_location_is_shared_hard_information():
    view = observe(scenario("mission"), "player")
    conditioned = observed_location_distribution(
        view, "xiaxi", dict.fromkeys(FRAME, 1 / len(FRAME))
    )
    assert conditioned[view.location] == 0
    assert sum(conditioned.values()) == pytest.approx(1)
    decision = choose_action(view, ToyModel(), strategy="strong_bayes")
    assert decision.action.kind == "move"
