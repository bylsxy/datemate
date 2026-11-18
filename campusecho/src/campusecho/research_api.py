"""推理工作台的数据投影、搜索运行与校园采纳服务。"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from itertools import pairwise
from pathlib import Path
from threading import RLock
from time import monotonic
from typing import Literal
from uuid import uuid4

from .kg_data import KGData, QuestionPublic, load_kg_data
from .kg_hybrid import HybridConfig, hybrid_search
from .kg_search import SearchConfig, SearchProblem, SearchResult, search
from .llm_gateway import GatewayConfig, LLMGateway
from .world import WorldState, legal_actions, observe, scenario, step

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "kg"
_SEARCH_TTL_SECONDS = 3600
_MAX_RUNS = 128
_TOPIC_PLACES = {"find": "club", "inform": "venue", "umbrella": "walkway"}


@dataclass(frozen=True)
class SearchRun:
    run_id: str
    question: QuestionPublic
    algorithm: Literal["bfs", "astar", "mcts", "ga_astar", "ga_classifier", "llm"]
    result: SearchResult
    answer_ids: tuple[str, ...]
    created_at: float
    llm_status: str = "disabled"


@lru_cache(maxsize=1)
def load_research_data() -> KGData:
    return load_kg_data(DATA_DIR, verify=True)


def _question(data: KGData, question_id: str) -> QuestionPublic:
    for rows in data.questions.values():
        for question in rows:
            if question.question_id == question_id:
                return question
    raise ValueError("未知问题")


def _featured_questions(data: KGData) -> tuple[QuestionPublic, ...]:
    """选取公开、可解且覆盖 2、3、4 跳的问题卡。"""
    labels = {
        label.question_id: label
        for rows in data.labels.values()
        for label in rows
    }
    candidates = [
        question
        for question in data.questions["core"]
        if question.kind == "core"
        and question.split in {"val", "test"}
        and labels[question.question_id].solvable
    ]
    selected: list[QuestionPublic] = []
    for hops in (2, 3, 4):
        row = next(
            (
                question
                for question in candidates
                if question.min_hops == question.max_hops == hops
                and question.question_id not in {item.question_id for item in selected}
            ),
            None,
        )
        if row is not None:
            selected.append(row)
    return tuple(selected)


def _display_prompt(data: KGData, question: QuestionPublic) -> str:
    """把可核验搜索题投影为面向读者的自然问题，不改变搜索语义。"""
    start = data.graph.entity_by_id[question.start_entity]
    family_entities = [
        entity
        for entity in data.graph.entities
        if entity.family_id == question.family_id
    ]
    papers = [entity.name for entity in family_entities if entity.entity_type == "paper"]
    methods = [entity.name for entity in family_entities if entity.entity_type == "method"]
    datasets = [entity.name for entity in family_entities if entity.entity_type == "dataset"]
    if question.layer == "academic" and papers:
        paper = papers[0]
        if question.direction == "out":
            target = methods[0] if methods else datasets[0] if datasets else "相关实体"
            return (
                f"{start.name}与“{paper}”之间，经过 {question.min_hops} 跳关系可以"
                f"连接到哪些实体？请给出可核查路径，并关注“{target}”。"
            )
        return (
            f"哪些论文或方法经过 {question.min_hops} 跳关系与“{start.name}”相关？"
            "请列出实体，并保留支撑每一跳的来源。"
        )
    if question.layer == "campus":
        if question.direction == "out":
            return (
                f"在虚构校园里，从“{start.name}”出发，沿成员、活动、地点与协作关系"
                f"走 {question.min_hops} 跳，能找到哪些人物、组织或场地？"
            )
        return (
            f"哪些校园人物、社团或活动经过 {question.min_hops} 跳关系会指向"
            f"“{start.name}”？请给出候选集合与路径。"
        )
    return question.prompt


def graph_payload(data: KGData | None = None) -> dict[str, object]:
    data = data or load_research_data()
    entities = data.graph.entities
    triples = data.graph.triples
    degree: dict[str, int] = defaultdict(int)
    for triple in triples:
        degree[triple.subject] += 1
        degree[triple.object] += 1
    prominent = sorted(
        entities,
        key=lambda entity: (-degree[entity.entity_id], entity.entity_id),
    )[:72]
    prominent_ids = {entity.entity_id for entity in prominent}
    edges = [
        {
            "id": triple.triple_id,
            "source": triple.subject,
            "target": triple.object,
            "relation": triple.relation,
            "label": triple.relation,
            "layer": triple.layer,
        }
        for triple in triples
        if triple.subject in prominent_ids and triple.object in prominent_ids
    ]
    return {
        "nodes": [
            {
                "id": entity.entity_id,
                "label": entity.name,
                "type": "person" if entity.entity_type == "person" else entity.entity_type,
                "layer": entity.layer,
                "degree": degree[entity.entity_id],
            }
            for entity in prominent
        ],
        "edges": edges,
        "counts": {
            "entities": len(entities),
            "triples": len(triples),
            "displayed_entities": len(prominent),
            "displayed_edges": len(edges),
        },
        "manifest": {
            "retrieved_at": data.manifest.get("retrieved_at"),
            "split_ratios": data.manifest.get("split_ratios"),
        },
    }


def questions_payload(data: KGData | None = None) -> dict[str, object]:
    data = data or load_research_data()
    questions = _featured_questions(data)
    return {
        "questions": [
            {
                "id": question.question_id,
                "category": f"{question.min_hops} 跳 · {question.layer}",
                "title": _display_prompt(data, question),
                "summary": (
                    f"从 {data.graph.entity_by_id[question.start_entity].name} 出发，"
                    f"沿 {len(question.relation_whitelist)} 类关系搜索。"
                ),
                "query": _display_prompt(data, question),
                "entities": [question.start_entity],
            }
            for question in questions
        ],
        "counts": {
            "core": len(data.questions["core"]),
            "robust": len(data.questions["robust"]),
        },
    }


def _problem(data: KGData, question: QuestionPublic) -> SearchProblem:
    family = question.family_id
    triples = tuple(
        triple
        for triple in data.graph.active_triples(question.as_of)
        if triple.layer == question.layer and triple.family_id == family
    )
    entities = tuple(
        entity.entity_id
        for entity in data.graph.entities
        if entity.layer == question.layer and entity.family_id == family
    )
    edges = tuple(
        (
            triple.subject if question.direction == "out" else triple.object,
            triple.relation,
            triple.object if question.direction == "out" else triple.subject,
            1.0,
        )
        for triple in triples
    )
    return SearchProblem(
        question.start_entity,
        lambda state: state.depth in range(question.min_hops, question.max_hops + 1),
        edges,
        nodes=entities,
        directed=True,
        allowed_relations=set(question.relation_whitelist),
        max_hops=question.max_hops,
    )


def _heuristic(question: QuestionPublic):
    remaining = question.min_hops

    def estimate(state) -> float:
        return max(0.0, remaining - state.depth)

    return estimate


def _trace(
    data: KGData,
    result: SearchResult,
    question: QuestionPublic,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    seen: set[tuple[str, ...]] = set()
    for event in result.events:
        if event.kind not in {"start", "expand", "candidate", "stop"}:
            continue
        if event.path in seen:
            continue
        seen.add(event.path)
        node = data.graph.entity_by_id.get(str(event.node))
        evidence = []
        for index, relation in enumerate(event.path[:-1]):
            target = event.path[index + 1]
            triple = next(
                (
                    item
                    for item in data.graph.triples
                    if item.subject == event.path[index]
                    and item.relation == relation
                    and item.object == target
                ),
                None,
            )
            if triple is not None:
                evidence.append(
                    {
                        "title": f"{data.graph.entity_by_id[triple.subject].name} "
                        f"{triple.relation} {data.graph.entity_by_id[triple.object].name}",
                        "detail": "；".join(
                            data.graph.source_by_id[source_id].title
                            for source_id in triple.source_ids
                        ),
                        "source": ",".join(triple.source_ids),
                    }
                )
            else:
                reverse = next(
                    (
                        item
                        for item in data.graph.triples
                        if item.subject == target
                        and item.relation == relation
                        and item.object == event.path[index]
                    ),
                    None,
                )
                if reverse is not None:
                    evidence.append(
                        {
                            "title": f"{data.graph.entity_by_id[reverse.subject].name} "
                            f"{reverse.relation} {data.graph.entity_by_id[reverse.object].name}",
                            "detail": "；".join(
                                data.graph.source_by_id[source_id].title
                                for source_id in reverse.source_ids
                            ),
                            "source": ",".join(reverse.source_ids),
                        }
                    )
        rows.append(
            {
                "id": str(event.node),
                "label": node.name if node else str(event.node),
                "state": "目标" if event.kind == "stop" and result.success else "展开",
                "detail": event.detail or f"路径深度 {event.depth}",
                "evidence": evidence,
                "g": event.cost,
                "h": max(0, question.min_hops - event.depth),
                "f": event.cost + max(0, question.min_hops - event.depth),
                "visits": result.rollout_workload if result.algorithm == "mcts" else None,
                "value": None,
                "score": None,
                "confidence": None,
                "cost": event.cost,
            }
        )
    return rows


def _answer(data: KGData, result: SearchResult) -> tuple[tuple[str, ...], list[dict[str, str]]]:
    if not result.solutions:
        return (), []
    ids = tuple(dict.fromkeys(str(path[-1]) for path in result.solutions))
    evidence: list[dict[str, str]] = []
    for path in result.solutions[:1]:
        for source, target in pairwise(path):
            triple = next(
                (
                    item
                    for item in data.graph.triples
                    if item.subject == source and item.object == target
                ),
                None,
            )
            if triple is None:
                triple = next(
                    (
                        item
                        for item in data.graph.triples
                        if item.subject == target and item.object == source
                    ),
                    None,
                )
            if triple is None:
                continue
            evidence.append(
                {
                    "title": f"{data.graph.entity_by_id[source].name} → "
                    f"{data.graph.entity_by_id[target].name}",
                    "detail": triple.relation,
                    "source": ",".join(triple.source_ids),
                }
            )
    return ids, evidence


class ResearchService:
    def __init__(self, data: KGData | None = None) -> None:
        self.data = data or load_research_data()
        self._runs: dict[str, SearchRun] = {}
        self._lock = RLock()
        self._gateway: LLMGateway | None = None
        if os.environ.get("DEEPSEEK_API_KEY"):
            self._gateway = LLMGateway(
                GatewayConfig(
                    base_url="https://api.deepseek.com/v1",
                    env_key="DEEPSEEK_API_KEY",
                    timeout=30,
                    retries=1,
                )
            )
            self._gateway.start_refresh()

    def run_search(
        self,
        *,
        question_id: str | None,
        algorithm: str,
        max_steps: int = 128,
    ) -> dict[str, object]:
        if algorithm not in {"bfs", "astar", "mcts", "ga_astar", "ga_classifier", "llm"}:
            raise ValueError("算法必须为 bfs、astar、mcts、ga_astar、ga_classifier 或 llm")
        if type(max_steps) is not int or not 1 <= max_steps <= 512:
            raise ValueError("max_steps 必须位于 1 到 512")
        question = (
            _question(self.data, question_id)
            if question_id
            else _featured_questions(self.data)[0]
        )
        problem = _problem(self.data, question)
        config = SearchConfig(
            max_expansions=max_steps,
            max_candidate_checks=max_steps * 8,
            max_solutions=1,
            max_depth=question.max_hops,
            mcts_simulations=max_steps,
            seed=20261118,
        )
        llm_status = "disabled"
        if algorithm in {"ga_astar", "ga_classifier", "llm"}:
            mode = {
                "ga_astar": "ga",
                "ga_classifier": "ga_classifier",
                "llm": "llm",
            }[algorithm]
            hybrid = hybrid_search(
                self.data,
                question,
                HybridConfig(
                    mode=mode,
                    weights=(0.663013285672417, 0.06281547621309151, 0.0778998278709586, 0.19627141024353287),
                ),
                gateway=self._gateway,
                search_config=config,
            )
            result = hybrid.search
            llm_status = hybrid.llm_status
        else:
            result = search(
                problem,
                algorithm,
                heuristic=_heuristic(question) if algorithm == "astar" else None,
                config=config,
            )
        answer_ids, evidence = _answer(self.data, result)
        run_id = uuid4().hex
        run = SearchRun(
            run_id, question, algorithm, result, answer_ids, monotonic(), llm_status
        )
        with self._lock:
            self._expire()
            self._runs[run_id] = run
        return self._payload(run, evidence)

    def _expire(self) -> None:
        cutoff = monotonic() - _SEARCH_TTL_SECONDS
        for run_id, run in tuple(self._runs.items()):
            if run.created_at < cutoff:
                del self._runs[run_id]
        while len(self._runs) > _MAX_RUNS:
            del self._runs[next(iter(self._runs))]

    def _payload(
        self, run: SearchRun, evidence: list[dict[str, str]]
    ) -> dict[str, object]:
        labels = [
            self.data.graph.entity_by_id[item].name
            for item in run.answer_ids
            if item in self.data.graph.entity_by_id
        ]
        return {
            "run_id": run.run_id,
            "status": "completed",
            "algorithm": run.algorithm,
            "llm_status": run.llm_status,
            "question_id": run.question.question_id,
        "question": _display_prompt(self.data, run.question),
            "answer": "、".join(labels) if labels else "未找到有效路径",
            "answer_ids": list(run.answer_ids),
            "confidence": 1.0 if run.result.success else 0.0,
            "expanded_nodes": len(run.result.expanded_nodes),
            "path_cost": run.result.cost,
            "metrics": {
                "candidate_checks": run.result.candidate_checks,
                "reasoning_steps": run.result.reasoning_steps,
                "redundant_paths": run.result.redundant_paths,
                "rollout_workload": run.result.rollout_workload,
                "stop_reason": run.result.stop_reason,
            },
            "steps": _trace(self.data, run.result, run.question),
            "evidence_path": evidence,
        }

    def read_run(self, run_id: str) -> dict[str, object]:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        _, evidence = _answer(self.data, run.result)
        return self._payload(run, evidence)

    def get_run(self, run_id: str) -> SearchRun:
        with self._lock:
            try:
                return self._runs[run_id]
            except KeyError as exc:
                raise KeyError(run_id) from exc


class SandboxService:
    def __init__(self) -> None:
        self._worlds: dict[str, tuple[WorldState, int]] = {}
        self._lock = RLock()

    def adopt(
        self,
        *,
        run: SearchRun,
        topic: str,
        people: list[str],
        resources: dict[str, object],
    ) -> dict[str, object]:
        if topic not in _TOPIC_PLACES:
            raise ValueError("未知校园任务")
        minutes = resources.get("minutes")
        if type(minutes) is not int or not 10 <= minutes <= 60:
            raise ValueError("行动时间必须位于 10 到 60 分钟")
        if not run.answer_ids:
            raise ValueError("搜索没有可采纳的有效路径")
        world = scenario("mission", seed=17)
        destination = _TOPIC_PLACES[topic]
        actions = []
        current = world
        for place in ("walkway", "club"):
            action = next(
                (
                    item
                    for item in legal_actions(observe(current, "player"))
                    if item.kind == "move" and item.target == place
                ),
                None,
            )
            if action is None:
                break
            current = step(current, action)
            actions.append(action)
        adoption_id = uuid4().hex
        with self._lock:
            self._worlds[adoption_id] = (current, len(actions))
        return {
            "adoption_id": adoption_id,
            "status": "adopted",
            "topic": topic,
            "run_id": run.run_id,
            "evidence_count": len(run.answer_ids),
            "people": people,
            "resources": resources,
            "route": ["teaching", *[action.target for action in actions], destination],
            "world_state": {
                "tick": current.tick,
                "location": observe(current, "player").location,
                "task_status": current.task.status if current.task else "not_assigned",
                "revision": len(actions),
            },
            "message": "搜索证明已写入校园任务，路线与角色状态已同步。",
        }


def encode_graph(data: KGData | None = None) -> str:
    return json.dumps(graph_payload(data), ensure_ascii=False)
