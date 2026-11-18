"""知识图谱搜索的规则、学习与 LLM 混合排序适配层。"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from math import exp
from pathlib import Path
from typing import Literal

import numpy as np

from .kg_data import KGData, QuestionPublic
from .kg_learning import (
    FEATURE_NAMES,
    GAConfig,
    GAResult,
    HeuristicGA,
    PathSample,
    PathValueClassifier,
    SearchOutcome,
)
from .kg_search import SearchConfig, SearchProblem, SearchResult, SearchState, astar
from .llm_gateway import KGActionCandidate, KGActionEvaluation, LLMGateway

HybridMode = Literal["manual", "ga", "ga_classifier", "llm"]
ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_DIR = ROOT / "artifacts" / "kg"


@dataclass(frozen=True)
class HybridConfig:
    mode: HybridMode = "manual"
    weights: tuple[float, float, float, float] = (0.25, 0.25, 0.25, 0.25)
    classifier: PathValueClassifier | None = None
    llm_weight: float = 0.25
    max_llm_calls: int = 8

    def __post_init__(self) -> None:
        if self.mode not in {"manual", "ga", "ga_classifier", "llm"}:
            raise ValueError("未知混合搜索模式")
        vector = np.asarray(self.weights, dtype=float)
        if vector.shape != (4,) or not np.isfinite(vector).all() or np.any(vector < 0):
            raise ValueError("启发权重必须是四个非负有限数")
        if vector.sum() <= 0:
            raise ValueError("启发权重至少需要一个正分量")
        if not 0 <= self.llm_weight <= 1:
            raise ValueError("llm_weight 必须位于 [0, 1]")
        if type(self.max_llm_calls) is not int or self.max_llm_calls < 0:
            raise ValueError("max_llm_calls 必须是非负整数")


@dataclass(frozen=True)
class HybridResult:
    search: SearchResult
    mode: HybridMode
    weights: tuple[float, float, float, float]
    llm_status: str
    llm_scored_actions: int
    trace_scores: tuple[dict[str, object], ...]


def _question_tokens(question: QuestionPublic) -> set[str]:
    return set(question.prompt.replace("“", " ").replace("”", " ").split())


def structural_features(
    data: KGData,
    question: QuestionPublic,
    state: SearchState,
) -> tuple[float, float, float, float]:
    """四维结构特征；不读取私有答案、路径或测试标签。"""
    entity = data.graph.entity_by_id.get(str(state.node))
    relation_matches = sum(
        relation in question.relation_whitelist for relation in state.relations
    )
    relation_ratio = relation_matches / max(1, len(state.relations))
    depth_ratio = min(1.0, state.depth / max(1, question.max_hops))
    family_size = sum(
        item.family_id == question.family_id for item in data.graph.entities
    )
    frontier = len(
        [
            triple
            for triple in data.graph.triples
            if triple.family_id == question.family_id
            and (
                (question.direction == "out" and triple.subject == state.node)
                or (question.direction == "in" and triple.object == state.node)
            )
        ]
    )
    type_prior = 1.0 if entity and entity.entity_type in {
        "paper",
        "method",
        "model",
        "person",
        "event",
        "place",
    } else 0.5
    return (
        depth_ratio,
        relation_ratio,
        1.0 - min(1.0, state.depth / max(1, question.max_hops)),
        type_prior * (1.0 - min(1.0, frontier / max(1, family_size))),
    )


def heuristic_for(
    data: KGData,
    question: QuestionPublic,
    weights: Sequence[float],
) -> Callable[[SearchState], float]:
    vector = np.asarray(weights, dtype=float)
    vector = vector / vector.sum()

    def estimate(state: SearchState) -> float:
        features = np.asarray(structural_features(data, question, state), dtype=float)
        remaining = max(0, question.min_hops - state.depth)
        learned = float(features @ vector)
        return float(remaining) + 0.25 * (1.0 - learned)

    return estimate


def _problem(data: KGData, question: QuestionPublic) -> SearchProblem:
    triples = [
        triple
        for triple in data.graph.active_triples(question.as_of)
        if triple.layer == question.layer and triple.family_id == question.family_id
    ]
    entities = [
        entity.entity_id
        for entity in data.graph.entities
        if entity.layer == question.layer and entity.family_id == question.family_id
    ]
    edges = [
        (
            triple.subject if question.direction == "out" else triple.object,
            triple.relation,
            triple.object if question.direction == "out" else triple.subject,
            1.0,
        )
        for triple in triples
    ]
    return SearchProblem(
        question.start_entity,
        lambda state: state.depth in range(question.min_hops, question.max_hops + 1),
        edges,
        nodes=entities,
        directed=True,
        allowed_relations=set(question.relation_whitelist),
        max_hops=question.max_hops,
    )


def _outcome(result: SearchResult) -> SearchOutcome:
    return SearchOutcome(
        result.success,
        len(result.expanded_nodes),
        result.reasoning_steps,
    )


def fit_ga(
    data: KGData,
    questions: Sequence[QuestionPublic],
    *,
    config: GAConfig | None = None,
) -> GAResult:
    """只用调用方提供的训练问题优化权重。"""
    if not questions:
        raise ValueError("GA 训练问题不能为空")

    def extractor(raw: Sequence[float]) -> Sequence[float]:
        return raw

    def evaluate(weights: np.ndarray, _extractor):
        outcomes = []
        for question in questions:
            result = astar(
                _problem(data, question),
                heuristic_for(data, question, weights),
                SearchConfig(
                    max_expansions=256,
                    max_candidate_checks=2048,
                    max_solutions=None,
                    max_depth=question.max_hops,
                    seed=20261118,
                ),
            )
            outcomes.append(_outcome(result))
        return outcomes

    ga = HeuristicGA(extractor, evaluate, config=config or GAConfig())
    return ga.fit()


def train_classifier(
    data: KGData,
    questions: Sequence[QuestionPublic],
) -> PathValueClassifier:
    samples: list[PathSample] = []
    for question in questions:
        result = astar(
            _problem(data, question),
            heuristic_for(data, question, (0.25, 0.25, 0.25, 0.25)),
            SearchConfig(
                max_expansions=128,
                max_candidate_checks=1024,
                max_solutions=None,
                max_depth=question.max_hops,
                seed=20261118,
            ),
        )
        for event in result.events:
            if event.kind not in {"candidate", "expand"}:
                continue
            state = SearchState(event.node, event.path, event.cost)
            label = any(
                solution[: len(state.path)] == state.path
                for solution in result.solutions
            )
            samples.append(
                PathSample(
                    structural_features(data, question, state),
                    label,
                    "train",
                )
            )
    if not samples or not any(item.label for item in samples) or not any(
        item.label is False for item in samples
    ):
        raise ValueError("分类器训练样本必须同时包含成功与失败路径")
    return PathValueClassifier.fit(samples)


def _llm_scores(
    gateway: LLMGateway,
    data: KGData,
    question: QuestionPublic,
    problem: SearchProblem,
    config: HybridConfig,
) -> tuple[dict[tuple[str, str], float], str, int]:
    frontier = list(problem.raw_candidates(SearchState(question.start_entity)))
    candidates = [
        KGActionCandidate(
            f"{relation}|{target}",
            relation,
            data.graph.entity_by_id[str(target)].name,
        )
        for target, relation, _ in frontier[: config.max_llm_calls]
    ]
    if not candidates:
        return {}, "empty", 0
    evaluation: KGActionEvaluation = gateway.evaluate_kg_actions(
        question.prompt,
        (data.graph.entity_by_id[question.start_entity].name,),
        (),
        candidates,
        use_cache=True,
    )
    scores = {
        (item.action_id.split("|", 1)[1], item.action_id.split("|", 1)[0]): item.reward
        for item in evaluation.scores
        if item.legal
    }
    return scores, evaluation.status, len(evaluation.scores)


def hybrid_search(
    data: KGData,
    question: QuestionPublic,
    config: HybridConfig,
    *,
    gateway: LLMGateway | None = None,
    search_config: SearchConfig | None = None,
) -> HybridResult:
    problem = _problem(data, question)
    llm_scores: dict[tuple[str, str], float] = {}
    llm_status = "disabled"
    llm_count = 0
    if config.mode == "llm":
        if gateway is None:
            llm_status = "unavailable"
        else:
            llm_scores, llm_status, llm_count = _llm_scores(
                gateway, data, question, problem, config
            )

    base = heuristic_for(data, question, config.weights)

    def estimate(state: SearchState) -> float:
        value = base(state)
        if state.relations and config.mode == "llm":
            relation = state.relations[-1]
            reward = llm_scores.get((str(state.node), relation), 0.0)
            value *= exp(-config.llm_weight * reward)
        if config.mode == "ga_classifier" and config.classifier is not None:
            probability = config.classifier.predict_proba(
                structural_features(data, question, state)
            )
            value *= 1.0 + 0.25 * (1.0 - probability)
        return max(0.0, value)

    result = astar(
        problem,
        estimate,
        search_config
        or SearchConfig(
            max_expansions=256,
            max_candidate_checks=2048,
            max_solutions=None,
            max_depth=question.max_hops,
            seed=20261118,
        ),
    )
    trace_scores = tuple(
        {
            "node": str(event.node),
            "path": list(event.path),
            "features": list(
                structural_features(
                    data,
                    question,
                    SearchState(event.node, event.path, event.cost),
                )
            ),
            "heuristic": estimate(
                SearchState(event.node, event.path, event.cost)
            ),
        }
        for event in result.events
        if event.kind in {"candidate", "expand"}
    )
    return HybridResult(
        result,
        config.mode,
        tuple(float(item) for item in config.weights),
        llm_status,
        llm_count,
        trace_scores,
    )


def freeze_models(
    directory: str | Path,
    *,
    ga: GAResult,
    classifier: PathValueClassifier,
    data: KGData,
) -> dict[str, object]:
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    ga_path = root / "ga_heuristic.json"
    classifier_path = root / "path_classifier.json"
    ga_path.write_text(
        json.dumps(ga.export_parameters(), ensure_ascii=False, sort_keys=True, indent=2)
        + "\n",
        encoding="utf-8",
    )
    classifier.save(classifier_path)
    payload = {
        "schema_version": 1,
        "features": list(FEATURE_NAMES),
        "ga": ga_path.name,
        "classifier": classifier_path.name,
        "data_manifest_sha256": hashlib.sha256(
            json.dumps(data.manifest, sort_keys=True).encode("utf-8")
        ).hexdigest(),
    }
    (root / "manifest.json").write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return payload


__all__ = [
    "ARTIFACT_DIR",
    "HybridConfig",
    "HybridResult",
    "fit_ga",
    "freeze_models",
    "heuristic_for",
    "hybrid_search",
    "structural_features",
    "train_classifier",
]
