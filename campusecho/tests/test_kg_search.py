"""统一知识图谱多跳搜索内核的行为测试。"""

import pytest

from campusecho.kg_search import (
    SearchConfig,
    SearchProblem,
    SearchState,
    astar,
    bfs,
    mcts,
    search,
)


def test_bfs_handles_cycles_and_collects_shortest_multiple_solutions():
    graph = SearchProblem(
        "s",
        "g",
        (("s", "a"), ("a", "s"), ("a", "b"), ("b", "a"), ("b", "g"), ("a", "c"), ("c", "g")),
    )
    result = bfs(graph, SearchConfig(max_solutions=2))

    assert result.success
    assert result.solutions == (("s", "a", "b", "g"), ("s", "a", "c", "g"))
    assert result.cost == 3
    assert result.redundant_paths >= 3
    assert result.stop_reason == "goal_found"
    assert any(event.detail == "cycle" for event in result.events)
    assert result.events[-1].kind == "stop"


def test_dead_end_and_no_solution_have_explicit_stop_reasons():
    dead_end = SearchProblem("s", "g", (("s", "dead"), ("other", "g")), nodes=("s", "dead", "other", "g"))
    result = bfs(dead_end)
    assert not result.found
    assert result.path is None
    assert result.solutions == ()
    assert result.stop_reason == "exhausted"
    assert result.expanded_nodes == ("s", "dead")


def test_query_constraints_keep_relation_state_and_blocked_nodes():
    graph = SearchProblem(
        "s",
        "g",
        (
            ("s", "stranger", "b", 1),
            ("s", "friend", "a", 1),
            ("a", "friend", "b", 1),
            ("b", "stranger", "g", 1),
            ("s", "friend", "x", 1),
        ),
        blocked_nodes={"x"},
        required_relations={"friend"},
    )
    result = bfs(graph)

    assert result.path == ("s", "a", "b", "g")
    assert any(event.detail == "blocked_node" for event in result.events)


def test_budget_exhaustion_is_reported_and_counts_are_consistent():
    graph = SearchProblem(
        "s",
        "g",
        (("s", "a"), ("s", "b"), ("a", "g"), ("b", "g")),
    )
    result = bfs(graph, SearchConfig(max_expansions=1))

    assert not result.found
    assert result.stop_reason == "budget_exhausted"
    assert result.budget_exhausted
    assert result.expanded_nodes == ("s",)
    assert result.reasoning_steps == 1
    assert result.candidate_checks == 2


def test_astar_h_zero_matches_bfs_exhaustive_path_set():
    graph = SearchProblem(
        "s",
        "g",
        (("s", "a"), ("s", "b"), ("a", "g"), ("b", "g")),
    )
    config = SearchConfig(max_solutions=None)
    breadth = bfs(graph, config)
    exhaustive = astar(graph, lambda _state: 0, config)

    assert breadth.solutions == exhaustive.solutions == (("s", "a", "g"), ("s", "b", "g"))
    assert exhaustive.cost == 2
    assert exhaustive.reasoning_steps == breadth.reasoning_steps


def test_astar_injected_heuristic_selects_goal_direction():
    graph = SearchProblem(
        "s",
        "g",
        (("s", "bad"), ("s", "good"), ("bad", "x"), ("x", "g"), ("good", "g")),
    )
    result = astar(graph, lambda state: 0 if state.node == "good" else 2)

    assert result.path == ("s", "good", "g")
    assert result.stop_reason == "goal_found"


def test_mcts_is_deterministic_replayable_and_counts_rollout_work():
    graph = SearchProblem(
        "s",
        "g",
        (("s", "a"), ("s", "b"), ("a", "c"), ("c", "g"), ("b", "g")),
    )
    config = SearchConfig(mcts_simulations=40, rollout_depth=8, seed=17)
    first = mcts(graph, config)
    second = mcts(graph, config)

    assert first == second
    assert first.success
    assert first.solution[-1] == "g"
    assert first.rollout_workload > 0
    assert first.seed == 17
    assert any(event.kind == "rollout" for event in first.events)
    assert sum(event.kind == "rollout" for event in first.events) == first.reasoning_steps


def test_mcts_budget_and_dead_end_are_explicit():
    dead_end = SearchProblem("s", "g", (("s", "dead"),), nodes=("s", "dead", "g"))
    result = mcts(dead_end, SearchConfig(mcts_simulations=5, seed=2))
    assert not result.found
    assert result.stop_reason == "exhausted"

    graph = SearchProblem("s", "g", (("s", "a"), ("a", "b"), ("b", "g")))
    budget = mcts(graph, SearchConfig(mcts_simulations=1, rollout_depth=1, seed=3))
    assert not budget.found
    assert budget.stop_reason == "budget_exhausted"
    assert budget.rollout_workload == 1


def test_search_dispatches_all_algorithms_and_rejects_unknown():
    graph = SearchProblem("s", "g", (("s", "g"),))
    assert search(graph, "bfs").path == ("s", "g")
    assert search(graph, "astar", heuristic=lambda _state: 0).path == ("s", "g")
    assert search(
        graph,
        "mcts",
        config=SearchConfig(mcts_simulations=2, seed=1),
    ).path == ("s", "g")
    with pytest.raises(ValueError):
        search(graph, "unknown")


def test_goal_predicate_and_required_relation_use_only_search_state():
    graph = SearchProblem(
        "s",
        lambda state: state.depth >= 2 and state.node == "g",
        (("s", "a", 1), ("a", "g", 1)),
        required_relations={""},
    )
    assert bfs(graph).path == ("s", "a", "g")


def test_config_and_problem_validation():
    with pytest.raises(ValueError):
        SearchConfig(max_expansions=-1)
    with pytest.raises(ValueError):
        SearchConfig(max_solutions=0)
    implicit_start = SearchProblem("missing", "g", (("s", "g"),))
    assert implicit_start.start == "missing"
    assert implicit_start.nodes == ("missing", "s", "g")
    with pytest.raises(ValueError):
        SearchProblem("s", "g", (("s", "unknown"),), nodes=("s", "g"))
    with pytest.raises(ValueError):
        SearchState("s", ("a", "s"), relations=("", ""))
    with pytest.raises(ValueError):
        astar(SearchProblem("s", "g", (("s", "g"),)), lambda _state: -1)

