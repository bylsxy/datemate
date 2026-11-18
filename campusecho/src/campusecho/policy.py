"""基于角色视图的一步期望信息价值；动作执行与世界真值不在本模块中。"""

from dataclasses import asdict, dataclass
from math import fsum

import networkx as nx

from .bayes import LocationBayes
from .evidence import Evidence, robust_fusion
from .world import EDGES, FRAME, Action, AgentView, legal_actions

GRAPH = nx.Graph()
GRAPH.add_weighted_edges_from(EDGES)
DISTANCES = dict(nx.all_pairs_dijkstra_path_length(GRAPH, weight="weight"))
SOURCE_FOR_CONTACT = {"xiaxi": "direct", "roommate": "roommate", "clubmate": "clubmate"}


@dataclass(frozen=True)
class PolicyConfig:
    confidence_threshold: float = 0.8
    conflict_threshold: float = 0.5
    wrong_location_cost: float = 15.0
    lateness_cost: float = 40.0
    query_cost: float = 2.0
    max_queries: int = 2


@dataclass(frozen=True)
class PolicyDecision:
    action: Action | None
    reason: str
    expected_cost: float | None = None
    information_value: float = 0.0
    alternatives: tuple[dict, ...] = ()
    strategy: str = "active"

    def as_dict(self):
        result = asdict(self)
        return result


def context_for_view(view):
    return {
        "time_of_day": "evening",
        "weather": "rain" if view.weather in {"rain", "showers"} else "clear",
    }


def _infer(model, evidence, now, context):
    return model.infer(evidence, now, context).probabilities


def observed_location_distribution(view, target, probabilities):
    """同地观察是所有动态策略共享的硬信息，包含明确的当前位置排除。

    当前校园原型中，同一节点的人物总能相互看见；这条假设不推广到现实场所。
    """
    if target == view.actor_id:
        return {state: float(state == view.location) for state in probabilities}
    seen = [
        o
        for o in view.observations
        if o.target == target and o.kind == "sighting" and o.evidence.observed_at == view.tick
    ]
    if seen:
        place = next(iter(seen[0].evidence.support))
        return {state: float(state == place) for state in probabilities}
    adjusted = {
        state: (0.0 if state == view.location else value) for state, value in probabilities.items()
    }
    total = fsum(adjusted.values())
    if total <= 0:
        choices = [state for state in probabilities if state != view.location]
        return {state: float(state in choices) / len(choices) for state in probabilities}
    return {state: value / total for state, value in adjusted.items()}


def _costs(probabilities, location, remaining, config):
    """先到一个候选地点的近似任务损失；只用地图、信念和公开剩余时间。"""
    result = {}
    for destination in GRAPH:
        if destination == location and probabilities.get(location, 0.0) == 0.0:
            continue
        travel = DISTANCES[location][destination]
        needed = travel + DISTANCES[destination]["venue"] + 4
        result[destination] = fsum(
            p
            * (
                travel
                + (config.wrong_location_cost if state != destination else 0)
                + (config.lateness_cost if needed > remaining else 0)
            )
            for state, p in probabilities.items()
        )
    return result


def _next_move(view, destination, actions):
    if destination == view.location:
        return next((a for a in actions if a.kind == "wait"), None)
    path = nx.shortest_path(GRAPH, view.location, destination, weight="weight")
    return next((a for a in actions if a.kind == "move" and a.target == path[1]), None)


def choose_action(view: AgentView, model, *, strategy="active", config=None):
    config = config or PolicyConfig()
    if strategy not in {"rule", "bayes", "strong_bayes", "hybrid", "active"}:
        raise ValueError("未知策略")
    task = getattr(view, "task", None)
    if task is None:
        return PolicyDecision(
            None, "此案例用于机制检查；任务模式提供完整目标与结算", strategy=strategy
        )
    if task.status != "active":
        return PolicyDecision(None, "任务已结算", strategy=strategy)
    if view.actor_id != task.owner:
        return PolicyDecision(None, "当前角色观察任务进展，由任务持有人决定行动", strategy=strategy)
    if view.location not in GRAPH:
        return PolicyDecision(None, "移动完成后再选择下一步", strategy=strategy)
    actions = legal_actions(view)
    for kind in ("inform", "confirm"):
        choice = next(
            (a for a in actions if a.kind == kind and (kind != "confirm" or a.item == "escort")),
            None,
        )
        if choice:
            return PolicyDecision(
                choice, "当前同地，先完成已证明可执行的任务步骤", strategy=strategy
            )
    if task.confirmed:
        return PolicyDecision(
            _next_move(view, task.goal_location, actions),
            "约定已确认，沿最短公开路线前往活动会场",
            strategy=strategy,
        )
    remaining = task.deadline - view.tick
    evidence = view.evidence_for(task.target)
    context = context_for_view(view)
    if strategy == "rule":
        reports = [
            e
            for e in evidence
            if e.support and e.observed_at <= view.tick and e.received_at <= view.tick
        ]
        destination = None
        for latest in sorted(
            reports, key=lambda e: (e.observed_at, e.received_at, e.evidence_id), reverse=True
        ):
            candidates = [s for s in latest.support if s in GRAPH and s != view.location]
            if candidates:
                destination = min(candidates, key=lambda s: (DISTANCES[view.location][s], s))
                break
        if destination is None:
            destination = min(
                (s for s in GRAPH if s != view.location),
                key=lambda s: (DISTANCES[view.location][s], s),
            )
        return PolicyDecision(
            _next_move(view, destination, actions),
            "规则基线采用最新可见位置报告",
            strategy=strategy,
        )
    if strategy == "bayes":
        probabilities = (
            LocationBayes(sorted(FRAME), tau=20).infer(evidence, view.tick).probabilities
        )
    else:
        probabilities = _infer(model, evidence, view.tick, context)
    probabilities = observed_location_distribution(view, task.target, probabilities)
    costs = _costs(probabilities, view.location, remaining, config)
    destination = min(costs, key=lambda s: (costs[s], s))
    baseline_cost = costs[destination]
    move = _next_move(view, destination, actions)
    if strategy in {"bayes", "strong_bayes"}:
        return PolicyDecision(
            move, "按位置后验比较公开路线和迟到代价", baseline_cost, strategy=strategy
        )
    from .learned import prepare_evidence

    prepared = prepare_evidence(evidence, view.tick)
    discounted = tuple(
        Evidence(
            e.evidence_id,
            e.source_id,
            e.origin_id,
            e.support,
            1.0
            if e.evidence_id.startswith(("self:", "sight:"))
            else model.source_reliability(
                SOURCE_FOR_CONTACT.get(e.source_id, e.source_id)
                if e.source_id in SOURCE_FOR_CONTACT
                else e.source_id
                if e.source_id in {"roommate", "clubmate", "camera", "direct"}
                else "direct",
                view.tick - e.observed_at,
            ),
            e.observed_at,
            e.received_at,
        )
        for e in prepared.selected
    )
    conflict = robust_fusion(discounted, FRAME).conflict
    query_count = sum(e.kind == "ask" and e.actor == view.actor_id for e in view.memories)
    candidates = [
        a
        for a in actions
        if a.kind == "ask" and a.target in SOURCE_FOR_CONTACT and a.minutes < remaining
    ]
    if query_count >= config.max_queries or not candidates:
        return PolicyDecision(
            move, "求证预算已用尽，依据当前信念行动", baseline_cost, strategy=strategy
        )
    if strategy == "hybrid":
        if (
            max(probabilities.values()) < config.confidence_threshold
            or conflict > config.conflict_threshold
        ):
            asked = {e.target for e in view.memories if e.kind == "ask"}
            query = min(
                candidates, key=lambda a: (a.target in asked, a.target != task.target, a.target)
            )
            return PolicyDecision(
                query, "学习后验或证据冲突触发有限求证", baseline_cost, strategy=strategy
            )
        return PolicyDecision(
            move, "后验与证据检查通过，按路线行动", baseline_cost, strategy=strategy
        )
    alternatives = []
    for query in candidates:
        source = SOURCE_FOR_CONTACT[query.target]
        distributions = {
            state: model.report_distribution(state, source, age=0, context=context)
            for state in probabilities
        }
        outcomes = sorted(next(iter(distributions.values())))
        expected_after = config.query_cost
        for report in outcomes:
            weight = fsum(probabilities[s] * distributions[s][report] for s in probabilities)
            if weight <= 0:
                continue
            hypothetical = tuple(evidence)
            if report != "__missing__":
                hypothetical += (
                    Evidence(
                        f"voi:{source}:{view.tick}:{report}",
                        source,
                        f"voi:{source}:{view.tick}",
                        frozenset({report}),
                        1.0,
                        view.tick + query.minutes,
                        view.tick + query.minutes,
                    ),
                )
            posterior = _infer(model, hypothetical, view.tick + query.minutes, context)
            posterior = observed_location_distribution(view, task.target, posterior)
            following = _costs(posterior, view.location, remaining - query.minutes, config)
            expected_after += weight * min(following.values())
        alternatives.append(
            {
                "action": asdict(query),
                "expected_cost": expected_after,
                "information_value": baseline_cost - expected_after,
            }
        )
    best = min(alternatives, key=lambda a: (a["expected_cost"], a["action"]["target"]))
    if best["information_value"] > 1e-9:
        return PolicyDecision(
            Action(**best["action"]),
            "这次求证预计能减少后续任务损失",
            best["expected_cost"],
            best["information_value"],
            tuple(alternatives),
            strategy,
        )
    return PolicyDecision(
        move,
        "查证的预计收益不足以抵偿时间成本，直接行动",
        baseline_cost,
        0.0,
        tuple(alternatives),
        strategy,
    )
