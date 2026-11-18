"""知识图谱上的统一多跳搜索内核。

搜索问题只由可见图结构、起点、目标谓词和查询约束构成。本模块不保存或读取
标准答案；BFS、A* 与 MCTS 共用同一套状态、事件和预算统计，便于直接比较
扩展节点、候选检查、冗余路径以及 MCTS rollout 的额外工作量。
"""

from __future__ import annotations

import heapq
import inspect
import math
import random
from collections import deque
from collections.abc import Callable, Collection, Hashable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal

Algorithm = Literal["bfs", "astar", "mcts"]
GoalPredicate = Callable[["SearchState"], bool]
Heuristic = Callable[["SearchState"], float]
Edge = tuple[Hashable, str, Hashable, float]


def _finite_nonnegative(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} 必须是有限数值")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} 必须是非负有限数值")
    return result


def _nonnegative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} 必须是非负整数")
    if value < 0:
        raise ValueError(f"{name} 必须非负")
    return value


def _positive_int(value: object, name: str) -> int:
    result = _nonnegative_int(value, name)
    if result == 0:
        raise ValueError(f"{name} 必须大于零")
    return result


def _ordered_values(values: Iterable[object]) -> tuple[object, ...]:
    """集合输入按稳定表示排序，序列输入保持调用方给出的顺序。"""

    if isinstance(values, (set, frozenset)):
        return tuple(sorted(values, key=repr))
    return tuple(values)


def _parse_edge(raw: object) -> Edge:
    if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
        raise TypeError("边必须是二元、三元或四元序列")
    values = tuple(raw)
    if len(values) == 2:
        source, target = values
        relation, weight = "", 1.0
    elif len(values) == 3:
        source, second, third = values
        if isinstance(third, (int, float)) and not isinstance(third, bool):
            relation, target, weight = "", second, third
        else:
            relation, target, weight = second, third, 1.0
    elif len(values) == 4:
        source, relation, target, weight = values
    else:
        raise ValueError("边必须包含 2、3 或 4 个字段")
    if not isinstance(source, Hashable) or not isinstance(target, Hashable):
        raise TypeError("边端点必须可哈希")
    if not isinstance(relation, str):
        raise TypeError("关系标签必须是字符串")
    return source, relation, target, _finite_nonnegative(weight, "边权重")


@dataclass(frozen=True, slots=True)
class SearchState:
    """一次搜索中的不可变路径状态。"""

    node: Hashable
    path: tuple[Hashable, ...] = ()
    cost: float = 0.0
    relations: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.node, Hashable):
            raise TypeError("node 必须可哈希")
        path = tuple(self.path) if self.path else (self.node,)
        if not path or path[-1] != self.node:
            raise ValueError("path 必须以 node 结尾")
        if any(not isinstance(item, Hashable) for item in path):
            raise TypeError("path 中的节点必须可哈希")
        relations = tuple(self.relations)
        if relations and len(relations) != len(path) - 1:
            raise ValueError("relations 必须与路径边数一致")
        if not relations:
            relations = ("",) * (len(path) - 1)
        if any(not isinstance(item, str) for item in relations):
            raise TypeError("relations 只能包含字符串")
        object.__setattr__(self, "path", path)
        object.__setattr__(self, "relations", relations)
        object.__setattr__(self, "cost", _finite_nonnegative(self.cost, "cost"))

    @property
    def depth(self) -> int:
        return len(self.path) - 1


@dataclass(frozen=True, slots=True)
class SearchEvent:
    """三种算法共用的可审计事件记录。"""

    step: int
    kind: str
    node: Hashable
    path: tuple[Hashable, ...]
    cost: float
    detail: str = ""

    @property
    def depth(self) -> int:
        return len(self.path) - 1


@dataclass(frozen=True, slots=True)
class SearchConfig:
    """搜索预算与 MCTS 参数。"""

    max_expansions: int = 1000
    max_candidate_checks: int | None = None
    max_depth: int | None = None
    max_solutions: int | None = 1
    mcts_simulations: int = 200
    rollout_depth: int | None = 64
    exploration_weight: float = math.sqrt(2.0)
    seed: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "max_expansions", _nonnegative_int(self.max_expansions, "max_expansions")
        )
        if self.max_candidate_checks is not None:
            object.__setattr__(
                self,
                "max_candidate_checks",
                _nonnegative_int(self.max_candidate_checks, "max_candidate_checks"),
            )
        if self.max_depth is not None:
            object.__setattr__(self, "max_depth", _nonnegative_int(self.max_depth, "max_depth"))
        if self.max_solutions is not None:
            object.__setattr__(
                self, "max_solutions", _positive_int(self.max_solutions, "max_solutions")
            )
        object.__setattr__(
            self,
            "mcts_simulations",
            _nonnegative_int(self.mcts_simulations, "mcts_simulations"),
        )
        if self.rollout_depth is not None:
            object.__setattr__(
                self, "rollout_depth", _nonnegative_int(self.rollout_depth, "rollout_depth")
            )
        object.__setattr__(
            self,
            "exploration_weight",
            _finite_nonnegative(self.exploration_weight, "exploration_weight"),
        )
        object.__setattr__(self, "seed", _nonnegative_int(self.seed, "seed"))


@dataclass(frozen=True, slots=True)
class SearchProblem:
    """可见知识图谱搜索问题。

    edges 支持二元边、带权三元边和带权关系四元边：
    (u, v)、(u, v, weight)、(u, relation, v)、(u, relation, v, weight)。
    无权边默认权重为 1。
    """

    start: Hashable
    goal: Hashable | GoalPredicate
    edges: Iterable[object] = ()
    nodes: Iterable[Hashable] = ()
    directed: bool = False
    allowed_nodes: Collection[Hashable] | Callable[[Hashable], bool] | None = None
    blocked_nodes: Collection[Hashable] = ()
    allowed_relations: Collection[str] | None = None
    required_relations: Collection[str] = ()
    max_hops: int | None = None
    _adjacency: Mapping[Hashable, tuple[tuple[Hashable, str, float], ...]] = field(
        init=False, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        if not isinstance(self.start, Hashable):
            raise TypeError("start 必须可哈希")
        if not callable(self.goal) and not isinstance(self.goal, Hashable):
            raise TypeError("goal 必须是可哈希目标或 SearchState 谓词")
        raw_edges = tuple(_parse_edge(raw) for raw in self.edges)
        raw_nodes = _ordered_values(self.nodes)
        if not raw_nodes:
            derived: list[Hashable] = [self.start]
            for source, _, target, _ in raw_edges:
                for node in (source, target):
                    if node not in derived:
                        derived.append(node)
            raw_nodes = tuple(derived)
        elif self.start not in raw_nodes:
            raise ValueError("start 必须存在于 nodes 中")
        nodes = tuple(raw_nodes)
        if len(set(nodes)) != len(nodes):
            raise ValueError("nodes 不能重复")
        if self.start not in nodes:
            raise ValueError("start 必须存在于 nodes 中")
        node_set = set(nodes)
        if any(source not in node_set or target not in node_set for source, _, target, _ in raw_edges):
            raise ValueError("边的端点必须存在于 nodes 中")
        if self.max_hops is not None:
            object.__setattr__(self, "max_hops", _nonnegative_int(self.max_hops, "max_hops"))
        if not isinstance(self.directed, bool):
            raise TypeError("directed 必须是 bool")
        allowed_nodes = self.allowed_nodes
        if allowed_nodes is not None and not callable(allowed_nodes):
            allowed_nodes = frozenset(allowed_nodes)
        blocked_nodes = frozenset(self.blocked_nodes)
        allowed_relations = (
            None if self.allowed_relations is None else frozenset(self.allowed_relations)
        )
        required_relations = frozenset(self.required_relations)
        if any(not isinstance(item, str) for item in required_relations):
            raise TypeError("required_relations 只能包含字符串")
        if allowed_relations is not None and any(
            not isinstance(item, str) for item in allowed_relations
        ):
            raise TypeError("allowed_relations 只能包含字符串")
        adjacency: dict[Hashable, list[tuple[Hashable, str, float]]] = {
            node: [] for node in nodes
        }
        seen: set[tuple[Hashable, str, Hashable, float, bool]] = set()
        for source, relation, target, weight in raw_edges:
            directions = ((source, target),) if self.directed else ((source, target), (target, source))
            for left, right in directions:
                key = (left, relation, right, weight, self.directed)
                if key in seen:
                    continue
                seen.add(key)
                adjacency[left].append((right, relation, weight))
        object.__setattr__(self, "nodes", nodes)
        object.__setattr__(self, "edges", raw_edges)
        object.__setattr__(self, "allowed_nodes", allowed_nodes)
        object.__setattr__(self, "blocked_nodes", blocked_nodes)
        object.__setattr__(self, "allowed_relations", allowed_relations)
        object.__setattr__(self, "required_relations", required_relations)
        object.__setattr__(
            self,
            "_adjacency",
            MappingProxyType({node: tuple(edges) for node, edges in adjacency.items()}),
        )

    def raw_candidates(self, state: SearchState) -> tuple[tuple[Hashable, str, float], ...]:
        """返回当前节点所有可见边，供算法统一统计候选检查。"""

        return self._adjacency.get(state.node, ())

    def accepts_node(self, node: Hashable) -> bool:
        if node in self.blocked_nodes:
            return False
        if self.allowed_nodes is None:
            return True
        if callable(self.allowed_nodes):
            return bool(self.allowed_nodes(node))
        return node in self.allowed_nodes

    def accepts_relation(self, relation: str) -> bool:
        return self.allowed_relations is None or relation in self.allowed_relations

    def is_goal(self, state: SearchState) -> bool:
        if not self.required_relations <= set(state.relations):
            return False
        if callable(self.goal):
            return bool(self.goal(state))
        return state.node == self.goal

    def child(self, state: SearchState, neighbor: Hashable, relation: str, weight: float) -> SearchState:
        return SearchState(
            neighbor,
            state.path + (neighbor,),
            state.cost + weight,
            state.relations + (relation,),
        )


@dataclass(frozen=True, slots=True)
class SearchResult:
    """统一搜索结果与审计统计。"""

    algorithm: str
    success: bool
    solution: tuple[Hashable, ...] | None
    solutions: tuple[tuple[Hashable, ...], ...]
    cost: float | None
    events: tuple[SearchEvent, ...]
    expanded_nodes: tuple[Hashable, ...]
    candidate_checks: int
    reasoning_steps: int
    redundant_paths: int
    stop_reason: str
    rollout_workload: int = 0
    seed: int = 0

    def __post_init__(self) -> None:
        solutions = tuple(tuple(path) for path in self.solutions)
        solution = None if self.solution is None else tuple(self.solution)
        if solution is None and solutions:
            solution = solutions[0]
        if solution is not None and solution not in solutions:
            solutions = (solution, *solutions)
        if self.success != bool(solutions):
            raise ValueError("success 必须与 solutions 是否为空一致")
        object.__setattr__(self, "solution", solution)
        object.__setattr__(self, "solutions", solutions)
        object.__setattr__(self, "events", tuple(self.events))
        object.__setattr__(self, "expanded_nodes", tuple(self.expanded_nodes))
        for name in (
            "candidate_checks",
            "reasoning_steps",
            "redundant_paths",
            "rollout_workload",
            "seed",
        ):
            object.__setattr__(self, name, _nonnegative_int(getattr(self, name), name))
        if self.cost is not None:
            object.__setattr__(self, "cost", _finite_nonnegative(self.cost, "cost"))

    @property
    def path(self) -> tuple[Hashable, ...] | None:
        return self.solution

    @property
    def found(self) -> bool:
        return self.success

    @property
    def budget_exhausted(self) -> bool:
        return self.stop_reason == "budget_exhausted"


@dataclass(frozen=True, slots=True)
class _Solution:
    state: SearchState


class _Trace:
    def __init__(self, algorithm: str, config: SearchConfig, root_node: Hashable) -> None:
        self.algorithm = algorithm
        self.config = config
        self.root_node = root_node
        self.events: list[SearchEvent] = []
        self.expanded_nodes: list[Hashable] = []
        self.candidate_checks = 0
        self.reasoning_steps = 0
        self.redundant_paths = 0
        self.rollout_workload = 0
        self.budget_stop: str | None = None

    def event(self, kind: str, state: SearchState, detail: str = "") -> None:
        self.events.append(
            SearchEvent(
                len(self.events),
                kind,
                state.node,
                state.path,
                state.cost,
                detail,
            )
        )

    def expand(self, state: SearchState, *, count_step: bool = True) -> bool:
        if len(self.expanded_nodes) >= self.config.max_expansions:
            self.budget_stop = "max_expansions"
            return False
        self.expanded_nodes.append(state.node)
        if count_step:
            self.reasoning_steps += 1
        self.event("expand", state)
        return True

    def check_candidate(self) -> bool:
        if (
            self.config.max_candidate_checks is not None
            and self.candidate_checks >= self.config.max_candidate_checks
        ):
            self.budget_stop = "max_candidate_checks"
            return False
        self.candidate_checks += 1
        return True

    def redundant(self, state: SearchState, detail: str) -> None:
        self.redundant_paths += 1
        self.event("reject", state, detail)

    def result(self, solutions: Sequence[_Solution], stop_reason: str) -> SearchResult:
        solution_states = [item.state for item in solutions]
        paths = tuple(item.path for item in solution_states)
        best = solution_states[0] if solution_states else None
        self.event("stop", best or SearchState(self.root_node), stop_reason)
        return SearchResult(
            self.algorithm,
            bool(solution_states),
            best.path if best else None,
            paths,
            best.cost if best else None,
            tuple(self.events),
            tuple(self.expanded_nodes),
            self.candidate_checks,
            self.reasoning_steps,
            self.redundant_paths,
            stop_reason,
            self.rollout_workload,
            self.config.seed,
        )


def _effective_depth(problem: SearchProblem, config: SearchConfig) -> int | None:
    limits = [value for value in (problem.max_hops, config.max_depth) if value is not None]
    return min(limits) if limits else None


def _constraint_key(problem: SearchProblem, state: SearchState) -> tuple[Hashable, frozenset[str]]:
    """只保留影响目标判定的已满足关系，允许更长路径补齐查询约束。"""

    satisfied = frozenset(problem.required_relations & set(state.relations))
    return state.node, satisfied


def _add_solution(
    solutions: list[_Solution],
    seen: set[tuple[Hashable, ...]],
    state: SearchState,
    config: SearchConfig,
) -> bool:
    if state.path not in seen:
        seen.add(state.path)
        solutions.append(_Solution(state))
    return config.max_solutions is not None and len(solutions) >= config.max_solutions


def _heuristic_value(heuristic: Heuristic | None, state: SearchState) -> float:
    if heuristic is None:
        return 0.0
    if not callable(heuristic):
        raise TypeError("heuristic 必须可调用或为 None")
    try:
        signature = inspect.signature(heuristic)
    except (TypeError, ValueError):
        value = heuristic(state)
    else:
        positional = [
            parameter
            for parameter in signature.parameters.values()
            if parameter.kind
            in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
        ]
        has_varargs = any(
            parameter.kind is inspect.Parameter.VAR_POSITIONAL
            for parameter in signature.parameters.values()
        )
        value = heuristic(state) if has_varargs or len(positional) >= 1 else heuristic()
    return _finite_nonnegative(value, "heuristic")


def bfs(problem: SearchProblem, config: SearchConfig | None = None) -> SearchResult:
    """按跳数进行广度优先搜索，并在预算内收集最短跳数解。"""

    config = config or SearchConfig()
    trace = _Trace("bfs", config, problem.start)
    root = SearchState(problem.start)
    trace.event("start", root)
    solutions: list[_Solution] = []
    seen_solutions: set[tuple[Hashable, ...]] = set()
    if problem.is_goal(root):
        _add_solution(solutions, seen_solutions, root, config)
        return trace.result(solutions, "goal_found")

    queue: deque[SearchState] = deque((root,))
    best_depth: dict[tuple[Hashable, frozenset[str]], int] = {_constraint_key(problem, root): 0}
    solution_depth: int | None = None
    seen_paths: set[tuple[Hashable, ...]] = {root.path}
    depth_limited = False
    depth_limit = _effective_depth(problem, config)
    while queue:
        if trace.budget_stop:
            break
        state = queue.popleft()
        if not trace.expand(state):
            break
        if depth_limit is not None and state.depth >= depth_limit:
            depth_limited = True
            continue
        for neighbor, relation, weight in problem.raw_candidates(state):
            if not trace.check_candidate():
                break
            child = problem.child(state, neighbor, relation, weight)
            if not problem.accepts_node(neighbor):
                trace.event("reject", child, "blocked_node")
                continue
            if not problem.accepts_relation(relation):
                trace.event("reject", child, "blocked_relation")
                continue
            if neighbor in state.path:
                trace.redundant(child, "cycle")
                continue
            state_key = _constraint_key(problem, child)
            prior_depth = best_depth.get(state_key)
            if prior_depth is not None and child.depth > prior_depth:
                trace.redundant(child, "longer_path")
                continue
            if child.path in seen_paths:
                trace.redundant(child, "duplicate_path")
                continue
            trace.event("candidate", child)
            seen_paths.add(child.path)
            if prior_depth is None or child.depth < prior_depth:
                best_depth[state_key] = child.depth
            if problem.is_goal(child):
                if solution_depth is None:
                    solution_depth = child.depth
                if child.depth == solution_depth:
                    if _add_solution(solutions, seen_solutions, child, config):
                        return trace.result(solutions, "goal_found")
                elif child.depth > solution_depth:
                    trace.redundant(child, "nonminimal_solution")
            else:
                queue.append(child)
    stop_reason = "budget_exhausted" if trace.budget_stop else (
        "depth_exhausted" if depth_limited else "exhausted"
    )
    return trace.result(solutions, stop_reason)


def astar(
    problem: SearchProblem,
    heuristic: Heuristic | None = None,
    config: SearchConfig | None = None,
) -> SearchResult:
    """使用可注入启发函数进行 A* 搜索；None 等价于 h=0。"""

    config = config or SearchConfig()
    trace = _Trace("astar", config, problem.start)
    root = SearchState(problem.start)
    trace.event("start", root)
    solutions: list[_Solution] = []
    seen_solutions: set[tuple[Hashable, ...]] = set()
    if problem.is_goal(root):
        _add_solution(solutions, seen_solutions, root, config)
        return trace.result(solutions, "goal_found")

    counter = 0
    frontier: list[tuple[float, float, int, SearchState]] = [(0.0, 0.0, counter, root)]
    best_cost: dict[tuple[Hashable, frozenset[str]], float] = {
        _constraint_key(problem, root): 0.0
    }
    seen_paths: set[tuple[Hashable, ...]] = {root.path}
    depth_limited = False
    depth_limit = _effective_depth(problem, config)
    solution_cost: float | None = None
    while frontier:
        if trace.budget_stop:
            break
        _, queued_cost, _, state = heapq.heappop(frontier)
        state_key = _constraint_key(problem, state)
        known_cost = best_cost.get(state_key)
        if known_cost is None or queued_cost > known_cost + 1e-12:
            trace.redundant(state, "stale_queue_entry")
            continue
        if problem.is_goal(state):
            if solution_cost is None:
                solution_cost = state.cost
            if state.cost <= solution_cost + 1e-12:
                if _add_solution(solutions, seen_solutions, state, config):
                    return trace.result(solutions, "goal_found")
                continue
            else:
                trace.redundant(state, "nonminimal_solution")
                continue
        if not trace.expand(state):
            break
        if depth_limit is not None and state.depth >= depth_limit:
            depth_limited = True
            continue
        for neighbor, relation, weight in problem.raw_candidates(state):
            if not trace.check_candidate():
                break
            child = problem.child(state, neighbor, relation, weight)
            if not problem.accepts_node(neighbor):
                trace.event("reject", child, "blocked_node")
                continue
            if not problem.accepts_relation(relation):
                trace.event("reject", child, "blocked_relation")
                continue
            if neighbor in state.path:
                trace.redundant(child, "cycle")
                continue
            child_key = _constraint_key(problem, child)
            prior_cost = best_cost.get(child_key)
            if (
                prior_cost is not None
                and child.cost > prior_cost + 1e-12
                and not problem.is_goal(child)
            ):
                trace.redundant(child, "higher_cost")
                continue
            if child.path in seen_paths:
                trace.redundant(child, "duplicate_path")
                continue
            trace.event("candidate", child)
            seen_paths.add(child.path)
            if prior_cost is None or child.cost < prior_cost:
                best_cost[child_key] = child.cost
            estimate = child.cost + _heuristic_value(heuristic, child)
            counter += 1
            heapq.heappush(frontier, (estimate, child.cost, counter, child))
    stop_reason = "budget_exhausted" if trace.budget_stop else (
        "depth_exhausted" if depth_limited else "exhausted"
    )
    return trace.result(solutions, stop_reason)


@dataclass(slots=True)
class _MCTSNode:
    state: SearchState
    parent: _MCTSNode | None
    untried: list[SearchState]
    children: list[_MCTSNode] = field(default_factory=list)
    visits: int = 0
    value: float = 0.0


def _mcts_untried(
    state: SearchState,
    problem: SearchProblem,
    trace: _Trace,
    rng: random.Random,
    depth_limit: int | None,
) -> list[SearchState]:
    if depth_limit is not None and state.depth >= depth_limit:
        return []
    candidates: list[SearchState] = []
    seen: set[tuple[Hashable, str]] = set()
    for neighbor, relation, weight in problem.raw_candidates(state):
        if not trace.check_candidate():
            break
        child = problem.child(state, neighbor, relation, weight)
        if not problem.accepts_node(neighbor):
            trace.event("reject", child, "blocked_node")
            continue
        if not problem.accepts_relation(relation):
            trace.event("reject", child, "blocked_relation")
            continue
        if neighbor in state.path:
            trace.redundant(child, "cycle")
            continue
        edge_key = (neighbor, relation)
        if edge_key in seen:
            trace.redundant(child, "duplicate_candidate")
            continue
        seen.add(edge_key)
        candidates.append(child)
    rng.shuffle(candidates)
    return candidates


def _uct(parent: _MCTSNode, child: _MCTSNode, exploration_weight: float) -> float:
    if child.visits == 0:
        return math.inf
    exploitation = child.value / child.visits
    exploration = exploration_weight * math.sqrt(
        math.log(max(1, parent.visits)) / child.visits
    )
    return exploitation + exploration


def _mcts_select(root: _MCTSNode, exploration_weight: float) -> _MCTSNode:
    node = root
    while not node.untried and node.children:
        node = max(
            node.children,
            key=lambda child: _uct(node, child, exploration_weight),
        )
    return node


def _mcts_rollout(
    start: SearchState,
    problem: SearchProblem,
    trace: _Trace,
    rng: random.Random,
    depth_limit: int | None,
) -> tuple[bool, SearchState, int]:
    state = start
    if problem.is_goal(state):
        return True, state, 0
    steps = 0
    rollout_limit = trace.config.rollout_depth
    while rollout_limit is None or steps < rollout_limit:
        if depth_limit is not None and state.depth >= depth_limit:
            break
        candidates: list[SearchState] = []
        for neighbor, relation, weight in problem.raw_candidates(state):
            if not trace.check_candidate():
                return False, state, steps
            child = problem.child(state, neighbor, relation, weight)
            if not problem.accepts_node(neighbor):
                trace.event("reject", child, "blocked_node")
                continue
            if not problem.accepts_relation(relation):
                trace.event("reject", child, "blocked_relation")
                continue
            if neighbor in state.path:
                trace.redundant(child, "cycle")
                continue
            candidates.append(child)
        if not candidates:
            break
        state = rng.choice(candidates)
        steps += 1
        trace.rollout_workload += 1
        if problem.is_goal(state):
            return True, state, steps
    return False, state, steps


def _mcts_backpropagate(node: _MCTSNode, reward: float) -> None:
    current: _MCTSNode | None = node
    while current is not None:
        current.visits += 1
        current.value += reward
        current = current.parent


def _mcts_has_frontier(root: _MCTSNode) -> bool:
    stack = [root]
    while stack:
        node = stack.pop()
        if node.untried:
            return True
        stack.extend(node.children)
    return False


def mcts(problem: SearchProblem, config: SearchConfig | None = None) -> SearchResult:
    """使用 UCT 的 MCTS，按固定种子执行选择、扩展、模拟和回传。"""

    config = config or SearchConfig()
    trace = _Trace("mcts", config, problem.start)
    root_state = SearchState(problem.start)
    trace.event("start", root_state)
    solutions: list[_Solution] = []
    seen_solutions: set[tuple[Hashable, ...]] = set()
    if problem.is_goal(root_state):
        _add_solution(solutions, seen_solutions, root_state, config)
        return trace.result(solutions, "goal_found")

    rng = random.Random(config.seed)
    depth_limit = _effective_depth(problem, config)
    root = _MCTSNode(
        root_state,
        None,
        _mcts_untried(root_state, problem, trace, rng, depth_limit),
    )
    if trace.budget_stop:
        return trace.result(solutions, "budget_exhausted")
    if not root.untried:
        return trace.result(solutions, "exhausted")

    for _ in range(config.mcts_simulations):
        if trace.budget_stop:
            break
        selected = _mcts_select(root, config.exploration_weight)
        if selected.untried:
            if not trace.expand(selected.state, count_step=False):
                break
            child_state = selected.untried.pop(0)
            trace.event("candidate", child_state)
            child = _MCTSNode(
                child_state,
                selected,
                _mcts_untried(child_state, problem, trace, rng, depth_limit),
            )
            selected.children.append(child)
            selected = child
        else:
            trace.event("expand", selected.state, "reuse_leaf")
        if trace.budget_stop:
            break
        success, terminal, rollout_steps = _mcts_rollout(
            selected.state,
            problem,
            trace,
            rng,
            depth_limit,
        )
        trace.reasoning_steps += 1
        trace.event(
            "rollout",
            terminal,
            f"success={success};steps={rollout_steps}",
        )
        if success and _add_solution(solutions, seen_solutions, terminal, config):
            return trace.result(solutions, "goal_found")
        _mcts_backpropagate(selected, 1.0 if success else 0.0)
        if trace.budget_stop:
            break
        if not _mcts_has_frontier(root):
            return trace.result(solutions, "exhausted")
    stop_reason = (
        "budget_exhausted"
        if trace.budget_stop or config.mcts_simulations > 0
        else "exhausted"
    )
    return trace.result(solutions, stop_reason)


def search(
    problem: SearchProblem,
    algorithm: Algorithm = "bfs",
    *,
    heuristic: Heuristic | None = None,
    config: SearchConfig | None = None,
) -> SearchResult:
    """统一入口；A* 的启发函数仅在 algorithm='astar' 时使用。"""

    if algorithm == "bfs":
        return bfs(problem, config)
    if algorithm == "astar":
        return astar(problem, heuristic, config)
    if algorithm == "mcts":
        return mcts(problem, config)
    raise ValueError("algorithm 必须是 bfs、astar 或 mcts")


a_star = astar


__all__ = [
    "Algorithm",
    "SearchConfig",
    "SearchEvent",
    "SearchProblem",
    "SearchResult",
    "SearchState",
    "a_star",
    "astar",
    "bfs",
    "mcts",
    "search",
]
