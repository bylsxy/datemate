"""Build a parent-child search tree from the unified search event stream.

The search kernels intentionally expose a small, algorithm-neutral event stream.
This module turns those events into a stable tree payload for the browser and
for static report figures.  A node is identified by its full entity path, so
the same entity may appear at different depths without being merged.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .kg_data import KGData, QuestionPublic
from .kg_search import SearchResult

_STATUS_PRIORITY = {
    "root": 6,
    "frontier": 1,
    "pruned": 2,
    "expanded": 3,
    "dead": 4,
    "goal": 5,
}
_STATUS_LABEL = {
    "root": "根节点",
    "frontier": "前沿",
    "pruned": "剪枝",
    "expanded": "已扩展",
    "dead": "无解",
    "goal": "目标",
}


def _node_id(path: Iterable[str]) -> str:
    return "|".join(str(item) for item in path)


def _event_status(event_kind: str, success: bool, algorithm: str) -> str:
    if event_kind == "start":
        return "root"
    if event_kind == "reject":
        return "pruned"
    if event_kind == "candidate":
        if algorithm == "mcts":
            return "expanded"
        return "frontier"
    if event_kind == "expand":
        return "expanded"
    if event_kind == "stop":
        return "goal" if success else "dead"
    return "frontier"


@dataclass
class _TreeNode:
    node_id: str
    entity_id: str
    path: tuple[str, ...]
    parent_id: str | None
    order: int
    status: str
    detail: str
    cost: float


def build_search_tree(
    data: KGData,
    result: SearchResult,
    question: QuestionPublic,
    algorithm: str,
) -> dict[str, object]:
    """Return a deterministic tree payload for one search result.

    ``rollout`` events are deliberately excluded from the tree because they
    are simulations rather than expanded tree nodes.  Their workload remains
    available through ``SearchResult.rollout_workload``.
    """

    nodes: dict[str, _TreeNode] = {}
    for event in result.events:
        if event.kind not in {"start", "candidate", "expand", "reject", "stop"}:
            continue
        path = tuple(str(item) for item in event.path)
        if not path:
            continue
        node_id = _node_id(path)
        status = _event_status(event.kind, result.success, algorithm)
        previous = nodes.get(node_id)
        if previous is not None and _STATUS_PRIORITY[previous.status] >= _STATUS_PRIORITY[status]:
            continue
        nodes[node_id] = _TreeNode(
            node_id=node_id,
            entity_id=path[-1],
            path=path,
            parent_id=_node_id(path[:-1]) if len(path) > 1 else None,
            order=event.step,
            status=status,
            detail=event.detail or f"路径深度 {event.depth}",
            cost=event.cost,
        )

    # Every event path has a prefix chain.  Add any prefix that was filtered
    # out (for example a goal reached before an explicit candidate event) so
    # the payload never contains a dangling parent reference.
    for item in tuple(nodes.values()):
        for depth in range(1, len(item.path)):
            prefix = item.path[:depth]
            prefix_id = _node_id(prefix)
            if prefix_id not in nodes:
                nodes[prefix_id] = _TreeNode(
                    node_id=prefix_id,
                    entity_id=prefix[-1],
                    path=prefix,
                    parent_id=_node_id(prefix[:-1]) if len(prefix) > 1 else None,
                    order=item.order,
                    status="frontier",
                    detail="由后续路径补齐的父节点",
                    cost=float(max(0, depth - 1)),
                )

    ordered = sorted(nodes.values(), key=lambda item: (item.order, len(item.path), item.node_id))
    node_rows: list[dict[str, object]] = []
    for item in ordered:
        entity = data.graph.entity_by_id.get(item.entity_id)
        depth = len(item.path) - 1
        h = None
        f = None
        if algorithm in {"astar", "hand_astar"}:
            h = float(max(0, question.max_hops - depth))
            f = item.cost + h
        node_rows.append(
            {
                "id": item.node_id,
                "parent_id": item.parent_id,
                "entity_id": item.entity_id,
                "label": entity.name if entity is not None else item.entity_id,
                "path": list(item.path),
                "depth": depth,
                "order": item.order,
                "status": item.status,
                "status_label": _STATUS_LABEL[item.status],
                "detail": item.detail,
                "g": item.cost,
                "h": h,
                "f": f,
                "visits": None,
                "value": None,
                "score": None,
            }
        )
    edges = [
        {
            "id": f"{item['parent_id']}->{item['id']}",
            "source": item["parent_id"],
            "target": item["id"],
            "order": item["order"],
        }
        for item in node_rows
        if item["parent_id"] is not None
    ]
    counts = {
        "nodes": len(node_rows),
        "expanded": sum(item["status"] == "expanded" for item in node_rows),
        "frontier": sum(item["status"] == "frontier" for item in node_rows),
        "pruned": sum(item["status"] == "pruned" for item in node_rows),
        "goals": sum(item["status"] == "goal" for item in node_rows),
    }
    return {
        "algorithm": result.algorithm,
        "root_id": _node_id((question.start_entity,)),
        "nodes": node_rows,
        "edges": edges,
        "counts": counts,
        "rollout_workload": result.rollout_workload,
    }


__all__ = ["build_search_tree"]
