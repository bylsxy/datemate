"""知识图谱搜索的正式对比实验与冻结结果框架。

本模块把公开问题、搜索方法、学习参数和私有评分严格分层：

* 搜索方法只接收 ``QuestionPublic`` 和 ``KnowledgeGraph``；
* GA 与路径分类器只在 train/val 问题上拟合；
* 私有 ``AnswerLabel`` 只在搜索结束后用于评分；
* test 只用于冻结参数后的评测，不参与任何拟合或阈值选择。

输出包含逐题记录、按 split/method 聚合的指标、冻结参数以及源码和数据指纹，
可直接供报告和 PPT 读取。
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from itertools import pairwise
from pathlib import Path
from time import perf_counter
from types import MappingProxyType
from typing import Literal

import numpy as np

from campusecho.kg_data import AnswerLabel, KGData, KnowledgeGraph, QuestionPublic
from campusecho.kg_learning import (
    FEATURE_COUNT,
    GAConfig,
    HeuristicGA,
    PathSample,
    PathValueClassifier,
    SearchOutcome,
    weighted_heuristic_score,
)
from campusecho.kg_search import SearchConfig, SearchProblem, SearchState, astar, bfs, mcts

SCHEMA_VERSION = 1
SPLITS = ("train", "val", "test")
QUESTION_SETS = ("core", "robust")
SearchMethod = Literal[
    "bfs",
    "hand_astar",
    "ga_astar",
    "mcts",
    "ga_astar_classifier",
]
METHODS: tuple[SearchMethod, ...] = (
    "bfs",
    "hand_astar",
    "ga_astar",
    "mcts",
    "ga_astar_classifier",
)
METHOD_LABELS = {
    "bfs": "BFS",
    "hand_astar": "手工 A*",
    "ga_astar": "GA-A*",
    "mcts": "MCTS",
    "ga_astar_classifier": "GA-A*+分类器",
}
ABLATION_LABELS = {
    "ga_astar": {
        "heuristic": "GA 学习权重",
        "classifier": False,
        "classifier_threshold": None,
        "ablation_of": None,
    },
    "ga_astar_classifier": {
        "heuristic": "GA 学习权重叠加路径分类器",
        "classifier": True,
        "classifier_threshold": "val 校准",
        "ablation_of": "ga_astar",
    },
}

LLMScoreCallback = Callable[["LLMScoreRequest"], object]


def _finite_nonnegative(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} 必须是有限数值")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} 必须是非负有限数值")
    return result


def _positive_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} 必须是正整数")
    if value <= 0:
        raise ValueError(f"{name} 必须大于零")
    return value


def _nonnegative_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} 必须是非负整数")
    if value < 0:
        raise ValueError(f"{name} 必须非负")
    return value


def _stable_seed(seed: int, value: str) -> int:
    digest = hashlib.sha256(f"{seed}:{value}".encode()).hexdigest()
    return int(digest[:16], 16)


def _question_stratum(question: QuestionPublic) -> tuple[str, int, int, str]:
    """固定抽样按 split、跳数和问题难度类型分层。"""

    return question.split, question.min_hops, question.max_hops, question.kind


def _allocate_quotas(
    groups: Mapping[tuple[object, ...], Sequence[QuestionPublic]], limit: int
) -> dict[tuple[object, ...], int]:
    """按组大小分配抽样名额，并尽量让每个非空层至少出现一次。"""

    keys = tuple(sorted(groups, key=repr))
    quotas = {key: 0 for key in keys}
    if limit <= 0 or not keys:
        return quotas
    total_questions = sum(len(groups[key]) for key in keys)
    if limit >= total_questions:
        return {key: len(groups[key]) for key in keys}

    remaining = limit
    if limit >= len(keys):
        for key in keys:
            quotas[key] = 1
        remaining -= len(keys)

    while remaining > 0:
        available = [key for key in keys if quotas[key] < len(groups[key])]
        if not available:
            break
        fractions: list[tuple[float, int, tuple[object, ...]]] = []
        for key in available:
            ideal = limit * len(groups[key]) / total_questions
            fractions.append((ideal - quotas[key], len(groups[key]), key))
        fractions.sort(key=lambda item: (item[0], item[1], repr(item[2])), reverse=True)
        quotas[fractions[0][2]] += 1
        remaining -= 1
    return quotas


def stratified_sample(
    questions: Iterable[QuestionPublic],
    *,
    limit: int | None,
    seed: int = 20261118,
) -> tuple[QuestionPublic, ...]:
    """按 ``(split, min_hops, max_hops, kind)`` 固定分层抽样。

    同一输入、limit 和 seed 始终返回同一组问题；结果按问题 ID 排序，便于
    在不同方法之间直接配对比较。limit=None 表示保留全部问题。
    """

    rows = tuple(questions)
    if limit is not None:
        limit = _nonnegative_int(limit, "limit")
    if limit is None or limit >= len(rows):
        return tuple(sorted(rows, key=lambda q: (q.split, q.question_id)))
    groups: dict[tuple[str, int, int, str], list[QuestionPublic]] = defaultdict(list)
    for question in rows:
        groups[_question_stratum(question)].append(question)
    for group in groups.values():
        group.sort(
            key=lambda q: (
                _stable_seed(seed, q.question_id),
                q.question_id,
            )
        )
    quotas = _allocate_quotas(groups, limit)
    selected: list[QuestionPublic] = []
    for key in sorted(groups, key=repr):
        selected.extend(groups[key][: quotas[key]])
    return tuple(sorted(selected, key=lambda q: (q.split, q.question_id)))


@dataclass(frozen=True, slots=True)
class LLMScoreRequest:
    """注入 LLM 评分器时可见的最小上下文，不包含私有标注。"""

    question: QuestionPublic
    method: SearchMethod
    method_label: str
    predicted_answers: tuple[str, ...]
    predicted_paths: tuple[tuple[str, ...], ...]
    search_stop_reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ExperimentConfig:
    """正式实验配置；所有随机性由 seed 和固定问题抽样控制。"""

    split: Literal["train", "val", "test", "all"] = "all"
    limit: int | None = None
    fit_limit: int | None = None
    methods: tuple[SearchMethod, ...] = METHODS
    seed: int = 20261118
    llm_subset_limit: int = 60
    max_expansions: int = 10_000
    max_candidate_checks: int | None = None
    mcts_simulations: int = 1_000
    rollout_depth: int | None = 8
    exploration_weight: float = math.sqrt(2.0)
    ga_population_size: int = 12
    ga_generations: int = 8
    ga_seeds: tuple[int, ...] = (20261118,)
    classifier_epochs: int = 600
    classifier_threshold: float | None = None
    classifier_prefix_limit: int = 100_000
    include_private_labels: bool = False

    def __post_init__(self) -> None:
        if self.split not in ("train", "val", "test", "all"):
            raise ValueError("split 必须是 train、val、test 或 all")
        if self.limit is not None:
            object.__setattr__(self, "limit", _positive_int(self.limit, "limit"))
        if self.fit_limit is not None:
            object.__setattr__(self, "fit_limit", _positive_int(self.fit_limit, "fit_limit"))
        methods = tuple(self.methods)
        if not methods or len(set(methods)) != len(methods):
            raise ValueError("methods 不能为空且不能重复")
        if any(method not in METHODS for method in methods):
            raise ValueError(f"未知搜索方法: {methods}")
        object.__setattr__(self, "methods", methods)
        object.__setattr__(self, "seed", _nonnegative_int(self.seed, "seed"))
        object.__setattr__(
            self,
            "llm_subset_limit",
            _nonnegative_int(self.llm_subset_limit, "llm_subset_limit"),
        )
        if self.llm_subset_limit > 60:
            raise ValueError("llm_subset_limit 不能超过 60")
        object.__setattr__(
            self, "max_expansions", _positive_int(self.max_expansions, "max_expansions")
        )
        if self.max_candidate_checks is not None:
            object.__setattr__(
                self,
                "max_candidate_checks",
                _nonnegative_int(self.max_candidate_checks, "max_candidate_checks"),
            )
        object.__setattr__(
            self,
            "mcts_simulations",
            _nonnegative_int(self.mcts_simulations, "mcts_simulations"),
        )
        if self.rollout_depth is not None:
            object.__setattr__(
                self,
                "rollout_depth",
                _nonnegative_int(self.rollout_depth, "rollout_depth"),
            )
        object.__setattr__(
            self,
            "exploration_weight",
            _finite_nonnegative(self.exploration_weight, "exploration_weight"),
        )
        object.__setattr__(
            self,
            "ga_population_size",
            _positive_int(self.ga_population_size, "ga_population_size"),
        )
        object.__setattr__(
            self, "ga_generations", _positive_int(self.ga_generations, "ga_generations")
        )
        seeds = tuple(self.ga_seeds)
        if not seeds or len(set(seeds)) != len(seeds):
            raise ValueError("ga_seeds 不能为空且不能重复")
        object.__setattr__(
            self, "ga_seeds", tuple(_nonnegative_int(seed, "ga_seed") for seed in seeds)
        )
        object.__setattr__(
            self,
            "classifier_epochs",
            _positive_int(self.classifier_epochs, "classifier_epochs"),
        )
        if self.classifier_threshold is not None:
            threshold = _finite_nonnegative(self.classifier_threshold, "classifier_threshold")
            if not 0 < threshold < 1:
                raise ValueError("classifier_threshold 必须位于 (0, 1)")
            object.__setattr__(self, "classifier_threshold", threshold)
        object.__setattr__(
            self,
            "classifier_prefix_limit",
            _positive_int(self.classifier_prefix_limit, "classifier_prefix_limit"),
        )
        if not isinstance(self.include_private_labels, bool):
            raise TypeError("include_private_labels 必须是 bool")

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class FrozenParameters:
    """训练完成后冻结的参数，不包含任何 test 标签。"""

    ga_weights: tuple[float, ...]
    classifier: PathValueClassifier
    classifier_threshold: float
    ga_parameters: Mapping[str, object]
    classifier_parameters: Mapping[str, object]
    metadata: Mapping[str, object]

    def __post_init__(self) -> None:
        weights = tuple(float(value) for value in self.ga_weights)
        if len(weights) != FEATURE_COUNT or not all(math.isfinite(value) for value in weights):
            raise ValueError("ga_weights 必须是四个有限数值")
        if not 0 < self.classifier_threshold < 1:
            raise ValueError("classifier_threshold 必须位于 (0, 1)")
        object.__setattr__(self, "ga_weights", weights)
        object.__setattr__(self, "ga_parameters", MappingProxyType(dict(self.ga_parameters)))
        object.__setattr__(
            self,
            "classifier_parameters",
            MappingProxyType(dict(self.classifier_parameters)),
        )
        object.__setattr__(self, "metadata", MappingProxyType(dict(self.metadata)))

    def export_parameters(self) -> dict[str, object]:
        return {
            "schema_version": SCHEMA_VERSION,
            "ga_weights": list(self.ga_weights),
            "classifier_threshold": self.classifier_threshold,
            "ga": dict(self.ga_parameters),
            "classifier": dict(self.classifier_parameters),
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True, slots=True)
class SearchRun:
    """一次问题在某个方法下的搜索结果与统一计数。"""

    paths: tuple[tuple[str, ...], ...]
    expanded_nodes: int
    candidate_checks: int
    reasoning_steps: int
    redundant_paths: int
    search_elapsed_seconds: float
    stop_reasons: tuple[str, ...]

    @property
    def answers(self) -> tuple[str, ...]:
        return tuple(sorted({path[-1] for path in self.paths}))

    @property
    def redundant_ratio(self) -> float:
        return self.redundant_paths / max(1, self.candidate_checks)


@dataclass(frozen=True, slots=True)
class ExperimentResult:
    summary: Mapping[str, object]
    records: tuple[Mapping[str, object], ...]
    parameters: Mapping[str, object]


def _label_map(
    data: KGData,
    question_ids: Iterable[str] | None = None,
) -> dict[str, AnswerLabel]:
    """构造评测器内部标签索引；调用方可以进一步限制到允许的问题 ID。"""

    allowed = None if question_ids is None else frozenset(question_ids)
    result: dict[str, AnswerLabel] = {}
    for set_name in QUESTION_SETS:
        for label in data.private_labels(set_name):
            if allowed is None or label.question_id in allowed:
                result[label.question_id] = label
    return result


def _all_public_questions(data: KGData) -> tuple[QuestionPublic, ...]:
    return tuple(
        question
        for set_name in QUESTION_SETS
        for question in data.public_questions(set_name)
    )


def _select_questions(
    data: KGData,
    *,
    split: str,
    limit: int | None,
    seed: int,
) -> tuple[QuestionPublic, ...]:
    all_questions = _all_public_questions(data)
    if split == "all":
        selected: list[QuestionPublic] = []
        for name in SPLITS:
            selected.extend(
                stratified_sample(
                    (q for q in all_questions if q.split == name),
                    limit=limit,
                    seed=seed,
                )
            )
        return tuple(sorted(selected, key=lambda q: (q.split, q.question_id)))
    if split not in SPLITS:
        raise ValueError("split 必须是 train、val、test 或 all")
    return stratified_sample(
        (q for q in all_questions if q.split == split),
        limit=limit,
        seed=seed,
    )


def _question_problem(
    graph: KnowledgeGraph,
    question: QuestionPublic,
    target_hops: int,
) -> SearchProblem:
    """把公开问题投影为分层搜索图，不读取任何标注。

    搜索状态使用 ``(entity_id, depth)``。这样同一实体在不同跳数层不会被
    最短路径去重，固定跳数目标仍能由搜索内核找到。
    """

    allowed = set(question.relation_whitelist)
    raw_edges: list[tuple[str, str, str]] = []
    for triple in graph.active_triples(question.as_of):
        if triple.layer != question.layer or triple.family_id != question.family_id:
            continue
        if triple.relation not in allowed:
            continue
        if question.direction == "out":
            raw_edges.append((triple.subject, triple.relation, triple.object))
        else:
            raw_edges.append((triple.object, triple.relation, triple.subject))
    # 只为实际可达的层生成节点，避免空叶子被内核当成普通扩展节点。
    reachable: dict[int, set[str]] = {0: {question.start_entity}}
    for depth in range(target_hops):
        next_layer = {
            target
            for source, _relation, target in raw_edges
            if source in reachable[depth]
        }
        reachable[depth + 1] = next_layer
    nodes = tuple(
        (entity, depth)
        for depth in range(target_hops + 1)
        for entity in sorted(reachable[depth])
    )
    edges = tuple(
        (
            (source, depth),
            relation,
            (target, depth + 1),
            1.0,
        )
        for depth in range(target_hops)
        for source, relation, target in raw_edges
        if source in reachable[depth] and target in reachable[depth + 1]
    )
    return SearchProblem(
        (question.start_entity, 0),
        lambda state: state.node[1] == target_hops,
        edges=edges,
        nodes=nodes,
        directed=True,
        allowed_relations=allowed,
        max_hops=target_hops,
    )


def _state_features(
    state: SearchState,
    problem: SearchProblem,
    target_hops: int,
) -> tuple[float, float, float, float]:
    """只从可见搜索状态提取四维特征，不接触实体答案或私有路径。"""

    remaining = max(0, target_hops - state.depth)
    goal_proximity = 1.0 / (1.0 + remaining)
    relation_count = len(set(state.relations))
    evidence_support = relation_count / max(1, len(state.relations))
    path_efficiency = 1.0 / (1.0 + state.depth)
    frontier_balance = 1.0 / (1.0 + len(problem.raw_candidates(state)))
    return (
        float(goal_proximity),
        float(evidence_support),
        float(path_efficiency),
        float(frontier_balance),
    )


def _path_features(
    problem: SearchProblem,
    path: tuple[str, ...],
    target_hops: int,
) -> tuple[float, float, float, float]:
    """从候选路径前缀提取与实体编号无关的特征。"""

    layered_path = tuple((node, depth) for depth, node in enumerate(path))
    relations: list[str] = []
    for left, right in pairwise(layered_path):
        candidates = problem.raw_candidates(SearchState(left))
        relation = next((rel for neighbor, rel, _weight in candidates if neighbor == right), "")
        relations.append(relation)
    state = SearchState(
        layered_path[-1],
        layered_path,
        float(len(path) - 1),
        tuple(relations),
    )
    return _state_features(state, problem, target_hops)


def _heuristic_for_method(
    method: SearchMethod,
    problem: SearchProblem,
    target_hops: int,
    ga_weights: Sequence[float],
    classifier: PathValueClassifier | None,
    classifier_threshold: float,
) -> Callable[[SearchState], float] | None:
    if method in ("bfs", "mcts"):
        return None
    if method == "hand_astar":
        return lambda state: float(max(0, target_hops - state.depth))

    def learned(state: SearchState) -> float:
        features = _state_features(state, problem, target_hops)
        score = weighted_heuristic_score(features, ga_weights)
        remaining = max(0, target_hops - state.depth)
        # 学习项只用于同层排序；剩余跳数保证启发式不会越过真实最短距离。
        if remaining == 0:
            return 0.0
        return float(remaining + 0.25 * (1.0 - min(1.0, max(0.0, score))))

    if method == "ga_astar":
        return learned
    if method != "ga_astar_classifier":
        raise ValueError(f"未知搜索方法: {method}")

    def classified(state: SearchState) -> float:
        features = _state_features(state, problem, target_hops)
        probability = (
            classifier.predict_proba(features) if classifier is not None else 0.5
        )
        confidence = max(0.0, min(1.0, probability))
        remaining = max(0, target_hops - state.depth)
        if remaining == 0:
            return 0.0
        return float(remaining + 0.25 * (1.0 - confidence))

    return classified


def run_search(
    question: QuestionPublic,
    graph: KnowledgeGraph,
    method: SearchMethod,
    *,
    config: ExperimentConfig | None = None,
    ga_weights: Sequence[float] = (0.25, 0.25, 0.25, 0.25),
    classifier: PathValueClassifier | None = None,
    classifier_threshold: float = 0.5,
) -> SearchRun:
    """运行一个方法；输入中没有答案字段，私有评分必须在函数外完成。"""

    if method not in METHODS:
        raise ValueError(f"未知搜索方法: {method}")
    config = config or ExperimentConfig()
    started = perf_counter()
    paths: set[tuple[str, ...]] = set()
    expanded = 0
    checks = 0
    steps = 0
    redundant = 0
    stop_reasons: list[str] = []
    for target_hops in range(question.min_hops, question.max_hops + 1):
        problem = _question_problem(graph, question, target_hops)
        search_config = SearchConfig(
            max_expansions=config.max_expansions,
            max_candidate_checks=config.max_candidate_checks,
            max_depth=target_hops,
            max_solutions=1,
            mcts_simulations=config.mcts_simulations,
            rollout_depth=config.rollout_depth,
            exploration_weight=config.exploration_weight,
            seed=_stable_seed(config.seed, f"{question.question_id}:{target_hops}"),
        )
        heuristic = _heuristic_for_method(
            method,
            problem,
            target_hops,
            ga_weights,
            classifier,
            classifier_threshold,
        )
        if method == "bfs":
            result = bfs(problem, search_config)
        elif method == "mcts":
            result = mcts(problem, search_config)
        else:
            result = astar(problem, heuristic, search_config)
        paths.update(tuple(str(node[0]) for node in path) for path in result.solutions)
        expanded += len(result.expanded_nodes)
        checks += result.candidate_checks
        steps += result.reasoning_steps
        redundant += result.redundant_paths
        stop_reasons.append(result.stop_reason)
    if paths and "budget_exhausted" not in stop_reasons:
        stop_reason = "goals_found"
    elif "budget_exhausted" in stop_reasons:
        stop_reason = "budget_exhausted"
    else:
        stop_reason = stop_reasons[0] if stop_reasons else "exhausted"
    return SearchRun(
        tuple(sorted(paths)),
        expanded,
        checks,
        steps,
        redundant,
        perf_counter() - started,
        (stop_reason, *stop_reasons),
    )


def score_prediction(
    predicted_paths: Iterable[Sequence[str]],
    label: AnswerLabel,
) -> dict[str, object]:
    """搜索结束后比较预测路径与私有 ``AnswerLabel``。"""

    paths = tuple(sorted({tuple(str(node) for node in path) for path in predicted_paths}))
    gold_paths = tuple(tuple(path) for path in label.paths)
    gold_path_set = set(gold_paths)
    predicted_answers = tuple(sorted({path[-1] for path in paths if path}))
    gold_answers = tuple(label.answers)
    answer_correct = (
        bool(predicted_answers) and set(predicted_answers) <= set(gold_answers)
    ) if label.solvable else not predicted_answers
    path_valid = (bool(paths) and set(paths) <= gold_path_set) if label.solvable else not paths
    path_complete = bool(paths) and set(paths) == gold_path_set
    path_intersection = len(set(paths) & gold_path_set)
    answer_intersection = len(set(predicted_answers) & set(gold_answers))
    answer_precision = (
        answer_intersection / len(predicted_answers)
        if predicted_answers
        else (1.0 if not gold_answers else 0.0)
    )
    answer_recall = (
        answer_intersection / len(gold_answers)
        if gold_answers
        else (1.0 if not predicted_answers else 0.0)
    )
    path_precision = (
        path_intersection / len(paths) if paths else (1.0 if not gold_paths else 0.0)
    )
    path_recall = (
        path_intersection / len(gold_paths) if gold_paths else (1.0 if not paths else 0.0)
    )
    # 主指标是找到至少一条有效路径并命中标准答案；完整枚举单独统计。
    success = answer_correct and path_valid
    if success:
        failure_reason = None
    elif label.solvable and not paths:
        failure_reason = "no_solution"
    elif label.solvable and paths and set(paths) < gold_path_set:
        failure_reason = "path_set_incomplete"
    elif label.solvable and paths and set(paths) > gold_path_set:
        failure_reason = "invalid_path"
    elif not answer_correct and not path_valid:
        failure_reason = "answer_and_path_mismatch"
    elif not answer_correct:
        failure_reason = "answer_mismatch"
    elif not path_valid:
        failure_reason = "invalid_path"
    elif not path_complete:
        failure_reason = "path_set_incomplete"
    else:
        failure_reason = "path_set_mismatch"
    return {
        "predicted_answers": predicted_answers,
        "predicted_paths": paths,
        "gold_answers": gold_answers,
        "gold_paths": gold_paths,
        "answer_correct": answer_correct,
        "path_valid": path_valid,
        "path_complete": path_complete,
        "success": success,
        "answer_precision": answer_precision,
        "answer_recall": answer_recall,
        "path_precision": path_precision,
        "path_recall": path_recall,
        "failure_reason": failure_reason,
    }


def _calibrate_threshold(
    classifier: PathValueClassifier,
    samples: Sequence[PathSample],
) -> float:
    if not samples:
        return 0.5
    best_threshold = 0.5
    best_score = -1.0
    for threshold in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        true_positive = true_negative = positive = negative = 0
        for sample in samples:
            predicted = classifier.predict_proba(sample.features) >= threshold
            if sample.label:
                positive += 1
                true_positive += int(predicted)
            else:
                negative += 1
                true_negative += int(not predicted)
        sensitivity = true_positive / positive if positive else 0.0
        specificity = true_negative / negative if negative else 0.0
        score = (sensitivity + specificity) / 2.0
        if score > best_score:
            best_score = score
            best_threshold = threshold
    return best_threshold


def _calibration_diagnostics(
    classifier: PathValueClassifier,
    samples: Sequence[PathSample],
    threshold: float,
    *,
    source: str,
) -> dict[str, object]:
    """记录 val 阈值校准的样本支持度，避免把退化校准误报为有效。"""

    positives = sum(sample.label is True for sample in samples)
    negatives = sum(sample.label is False for sample in samples)
    return {
        "sample_count": len(samples),
        "positive_count": positives,
        "negative_count": negatives,
        "threshold": threshold,
        "source": source,
        "valid": bool(samples) and positives > 0 and negatives > 0,
    }


def _classifier_samples(
    graph: KnowledgeGraph,
    questions: Sequence[QuestionPublic],
    labels: Mapping[str, AnswerLabel],
    config: ExperimentConfig,
) -> tuple[list[PathSample], list[PathSample]]:
    """从 train/val 的公开图分支构造正负样本，test 在入口处直接拒绝。"""

    train_samples: list[PathSample] = []
    val_samples: list[PathSample] = []
    prefix_count = 0
    for question in questions:
        if question.split not in ("train", "val"):
            continue
        label = labels[question.question_id]
        gold_paths = tuple(tuple(path) for path in label.paths)
        # 训练期显式遍历公开图的有界前缀；成功路径与失败分支都进入样本。
        for target_hops in range(question.min_hops, question.max_hops + 1):
            problem = _question_problem(graph, question, target_hops)
            stack: list[SearchState] = [SearchState(problem.start)]
            while stack:
                if prefix_count >= config.classifier_prefix_limit:
                    return train_samples, val_samples
                state = stack.pop()
                prefix = tuple(str(node[0]) for node in state.path)
                positive = any(gold[: len(prefix)] == prefix for gold in gold_paths)
                sample = PathSample(
                    _path_features(problem, prefix, target_hops),
                    positive,
                    question.split,
                )
                if question.split == "train":
                    train_samples.append(sample)
                else:
                    val_samples.append(sample)
                prefix_count += 1
                if state.depth >= target_hops:
                    continue
                for neighbor, relation, weight in reversed(problem.raw_candidates(state)):
                    child = problem.child(state, neighbor, relation, weight)
                    if neighbor not in state.path and problem.accepts_node(neighbor):
                        stack.append(child)
    return train_samples, val_samples


def fit_experiment_parameters(
    data: KGData,
    config: ExperimentConfig | None = None,
) -> FrozenParameters:
    """只用 train/val 拟合 GA 与分类器，并冻结结果。"""

    config = config or ExperimentConfig()
    fit_questions = _select_questions(
        data,
        split="all",
        limit=config.fit_limit,
        seed=config.seed,
    )
    fit_questions = tuple(q for q in fit_questions if q.split in ("train", "val"))
    fit_ids = {question.question_id for question in fit_questions}
    labels = _label_map(data, fit_ids)
    train_questions = tuple(q for q in fit_questions if q.split == "train")
    val_questions = tuple(q for q in fit_questions if q.split == "val")
    ga_status = "fitted"
    ga_parameters: dict[str, object] = {}
    if train_questions:

        def evaluate(weights: np.ndarray, _extractor: object) -> list[SearchOutcome]:
            outcomes: list[SearchOutcome] = []
            for question in train_questions:
                run = run_search(
                    question,
                    data.graph,
                    "ga_astar",
                    config=config,
                    ga_weights=tuple(float(value) for value in weights),
                )
                label = labels[question.question_id]
                score = score_prediction(run.paths, label)
                correct = bool(score["success"])
                outcomes.append(
                    SearchOutcome(correct, run.expanded_nodes, run.reasoning_steps)
                )
            return outcomes

        ga_config = GAConfig(
            population_size=config.ga_population_size,
            generations=config.ga_generations,
            seeds=config.ga_seeds,
            tournament_size=min(3, config.ga_population_size),
            elite_count=min(2, config.ga_population_size),
        )
        try:
            ga_result = HeuristicGA(lambda raw: raw, evaluate, config=ga_config).fit()
            ga_weights = tuple(float(value) for value in ga_result.best_weights)
            ga_parameters = ga_result.export_parameters()
        except (ValueError, RuntimeError) as exc:
            ga_status = f"fallback:{type(exc).__name__}"
            ga_weights = (0.25, 0.25, 0.25, 0.25)
            ga_parameters = {"fallback_reason": str(exc)}
    else:
        ga_status = "fallback:no_train_questions"
        ga_weights = (0.25, 0.25, 0.25, 0.25)
        ga_parameters = {"fallback_reason": ga_status}

    train_samples, val_samples = _classifier_samples(
        data.graph,
        fit_questions,
        labels,
        config,
    )
    classifier_status = "fitted"
    try:
        if not train_samples:
            raise ValueError("训练样本不能为空")
        labels_present = {sample.label for sample in train_samples}
        if labels_present != {False, True}:
            raise ValueError("训练样本必须同时包含正负类")
        classifier = PathValueClassifier.fit(
            train_samples,
            epochs=config.classifier_epochs,
        )
        classifier_parameters = classifier.export_parameters()
    except (ValueError, TypeError) as exc:
        classifier_status = f"fallback:{type(exc).__name__}"
        classifier = PathValueClassifier((0.0, 0.0, 0.0, 0.0), 0.0)
        classifier_parameters = {
            **classifier.export_parameters(),
            "fallback_reason": str(exc),
        }
    threshold = config.classifier_threshold
    if threshold is None:
        threshold = _calibrate_threshold(classifier, val_samples)
    classifier_threshold_source = (
        "config" if config.classifier_threshold is not None else "val_balanced_accuracy"
    )
    calibration = _calibration_diagnostics(
        classifier,
        val_samples,
        float(threshold),
        source=classifier_threshold_source,
    )
    if config.classifier_threshold is None and not calibration["valid"]:
        classifier_threshold_source = "fallback:val_has_one_class"
        calibration["source"] = classifier_threshold_source
    metadata = {
        "fit_splits": ["train", "val"],
        "test_used_for_fit": False,
        "fit_question_count": len(fit_questions),
        "train_question_count": len(train_questions),
        "val_question_count": len(val_questions),
        "train_sample_count": len(train_samples),
        "val_sample_count": len(val_samples),
        "ga_status": ga_status,
        "ga_fallback_reason": ga_parameters.get("fallback_reason"),
        "classifier_status": classifier_status,
        "classifier_fallback_reason": classifier_parameters.get("fallback_reason"),
        "classifier_threshold_source": classifier_threshold_source,
        "classifier_calibration": calibration,
        "frozen_before_test": True,
    }
    return FrozenParameters(
        ga_weights,
        classifier,
        float(threshold),
        ga_parameters,
        classifier_parameters,
        metadata,
    )


def _normalize_llm_score(value: object) -> tuple[float | None, object, str | None]:
    if value is None:
        return None, None, None
    if isinstance(value, bool):
        return None, value, "LLM 分数不能是 bool"
    if isinstance(value, (int, float)):
        score = float(value)
        if not math.isfinite(score):
            return None, value, "LLM 分数不是有限数值"
        return score, value, None
    if isinstance(value, Mapping):
        raw_score = value.get("score")
        if raw_score is None:
            return None, dict(value), "LLM 返回缺少 score"
        if isinstance(raw_score, bool) or not isinstance(raw_score, (int, float)):
            return None, dict(value), "LLM score 不是数值"
        score = float(raw_score)
        if not math.isfinite(score):
            return None, dict(value), "LLM 分数不是有限数值"
        return score, dict(value), None
    return None, value, "LLM 返回值必须是数值、映射或 None"


def _aggregate(records: Sequence[Mapping[str, object]]) -> dict[str, object]:
    count = len(records)
    if not count:
        return {
            "questions": 0,
            "answer_accuracy": 0.0,
            "path_valid_rate": 0.0,
            "path_complete_rate": 0.0,
            "success_rate": 0.0,
            "mean_expanded_nodes": 0.0,
            "mean_candidate_checks": 0.0,
            "mean_reasoning_steps": 0.0,
            "mean_redundant_ratio": 0.0,
            "total_elapsed_seconds": 0.0,
            "mean_elapsed_seconds": 0.0,
            "failure_reason_counts": {},
            "llm_scored": 0,
            "mean_llm_score": None,
        }
    llm_scores = [
        float(row["llm_score"])
        for row in records
        if row.get("llm_score") is not None
    ]
    failures = Counter(
        str(row["failure_reason"])
        for row in records
        if row.get("failure_reason") is not None
    )
    return {
        "questions": count,
        "answer_correct_count": sum(bool(row["answer_correct"]) for row in records),
        "path_valid_count": sum(bool(row["path_valid"]) for row in records),
        "path_complete_count": sum(bool(row["path_complete"]) for row in records),
        "success_count": sum(bool(row["success"]) for row in records),
        "answer_accuracy": sum(bool(row["answer_correct"]) for row in records) / count,
        "path_valid_rate": sum(bool(row["path_valid"]) for row in records) / count,
        "path_complete_rate": (
            sum(bool(row["path_complete"]) for row in records) / count
        ),
        "success_rate": sum(bool(row["success"]) for row in records) / count,
        "mean_expanded_nodes": (
            sum(int(row["expanded_nodes"]) for row in records) / count
        ),
        "mean_candidate_checks": (
            sum(int(row["candidate_checks"]) for row in records) / count
        ),
        "mean_reasoning_steps": (
            sum(int(row["reasoning_steps"]) for row in records) / count
        ),
        "mean_redundant_ratio": (
            sum(float(row["redundant_ratio"]) for row in records) / count
        ),
        "total_elapsed_seconds": sum(float(row["elapsed_seconds"]) for row in records),
        "mean_elapsed_seconds": (
            sum(float(row["elapsed_seconds"]) for row in records) / count
        ),
        "failure_reason_counts": dict(sorted(failures.items())),
        "llm_scored": len(llm_scores),
        "mean_llm_score": sum(llm_scores) / len(llm_scores) if llm_scores else None,
    }


def _fingerprints(data_dir: Path | None) -> dict[str, object]:
    project = Path(__file__).resolve().parents[2]
    source_paths = (
        project / "src/campusecho/kg_experiment.py",
        project / "src/campusecho/kg_search.py",
        project / "src/campusecho/kg_learning.py",
        project / "src/campusecho/kg_data.py",
        project / "tools/run_kg_experiment.py",
        project / "tests/test_kg_experiment.py",
    )
    source = {
        path.relative_to(project).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source_paths
        if path.exists()
    }
    data: dict[str, object] = {}
    if data_dir is not None:
        data_root = Path(data_dir)
        for name in (
            "graph.json",
            "questions_public.jsonl",
            "answers_private.jsonl",
            "manifest.json",
        ):
            path = data_root / name
            if path.exists():
                data[name] = {
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "bytes": path.stat().st_size,
                }
    return {
        "source": source,
        "data": data,
        "source_scope": [
            "src/campusecho/kg_experiment.py",
            "src/campusecho/kg_search.py",
            "src/campusecho/kg_learning.py",
            "src/campusecho/kg_data.py",
            "tools/run_kg_experiment.py",
            "tests/test_kg_experiment.py",
        ],
        "data_scope": [
            "graph.json",
            "questions_public.jsonl",
            "answers_private.jsonl",
            "manifest.json",
        ],
    }


def _experiment_protocol(config: ExperimentConfig) -> dict[str, object]:
    """冻结影响实验结果的接口、指标和训练边界。"""

    return {
        "schema_version": SCHEMA_VERSION,
        "methods": list(config.methods),
        "method_labels": dict(METHOD_LABELS),
        "ablation_labels": dict(ABLATION_LABELS),
        "splits": {
            "fit": ["train", "val"],
            "evaluation": config.split,
            "test_frozen": True,
        },
        "metrics": [
            "answer_accuracy",
            "path_valid_rate",
            "path_complete_rate",
            "mean_expanded_nodes",
            "mean_candidate_checks",
            "mean_reasoning_steps",
            "mean_redundant_ratio",
            "success_rate",
            "mean_elapsed_seconds",
            "failure_reason_counts",
        ],
        "success_definition": "answer_correct and path_valid",
        "path_complete_definition": "all fixed-hop gold paths were returned",
        "search_solution_policy": "max_solutions=1 per target hop; only actual search solutions count",
        "classifier_training": "bounded public-graph prefixes; train/val only; includes positive and failed branches",
        "answer_metric": "set equality over terminal entity IDs",
        "path_metric": "exact equality over all fixed-hop simple paths",
        "llm_subset": {
            "maximum": 60,
            "strata": ["split", "min_hops", "max_hops", "kind"],
            "same_questions_for_all_methods": True,
            "callback_receives_private_labels": False,
        },
        "search_state": "layered (entity_id, depth) to preserve fixed-hop paths",
        "source_fingerprint_scope": "experiment runner, search, learning, data loader, CLI and tests",
        "data_fingerprint_scope": "graph, public questions, private labels and manifest",
    }


def _fingerprint_payload(fingerprints: Mapping[str, object]) -> str:
    """生成不含运行时间的稳定指纹，供跨运行比较。"""

    payload = {
        "source": dict(fingerprints.get("source", {})),
        "data": dict(fingerprints.get("data", {})),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _record_base(
    question: QuestionPublic,
    method: SearchMethod,
    run: SearchRun,
    score: Mapping[str, object],
    *,
    elapsed_seconds: float,
    include_private_labels: bool,
) -> dict[str, object]:
    record: dict[str, object] = {
        "question_id": question.question_id,
        "set_name": question.set_name,
        "split": question.split,
        "layer": question.layer,
        "family_id": question.family_id,
        "kind": question.kind,
        "min_hops": question.min_hops,
        "max_hops": question.max_hops,
        "direction": question.direction,
        "method": method,
        "method_label": METHOD_LABELS[method],
        "predicted_answers": list(score["predicted_answers"]),
        "predicted_paths": [list(path) for path in score["predicted_paths"]],
        "predicted_answer_count": len(score["predicted_answers"]),
        "predicted_path_count": len(score["predicted_paths"]),
        "answer_correct": bool(score["answer_correct"]),
        "path_valid": bool(score["path_valid"]),
        "path_complete": bool(score["path_complete"]),
        "success": bool(score["success"]),
        "answer_precision": float(score["answer_precision"]),
        "answer_recall": float(score["answer_recall"]),
        "path_precision": float(score["path_precision"]),
        "path_recall": float(score["path_recall"]),
        "expanded_nodes": run.expanded_nodes,
        "candidate_checks": run.candidate_checks,
        "reasoning_steps": run.reasoning_steps,
        "redundant_paths": run.redundant_paths,
        "redundant_ratio": run.redundant_ratio,
        "search_elapsed_seconds": run.search_elapsed_seconds,
        "elapsed_seconds": elapsed_seconds,
        "search_stop_reasons": list(run.stop_reasons),
        "failure_reason": score["failure_reason"],
        "llm_score": None,
        "llm_score_detail": None,
        "llm_error": None,
    }
    if include_private_labels:
        record["gold_answers"] = list(score["gold_answers"])
        record["gold_paths"] = [list(path) for path in score["gold_paths"]]
        record["gold_answer_count"] = len(score["gold_answers"])
        record["gold_path_count"] = len(score["gold_paths"])
    return record


def run_experiment(
    data: KGData,
    config: ExperimentConfig | None = None,
    *,
    data_dir: str | Path | None = None,
    llm_scorer: LLMScoreCallback | None = None,
) -> ExperimentResult:
    """冻结参数后运行所有方法，并生成可序列化结果。"""

    config = config or ExperimentConfig()
    started = perf_counter()
    frozen = fit_experiment_parameters(data, config)
    questions = _select_questions(
        data,
        split=config.split,
        limit=config.limit,
        seed=config.seed,
    )
    if not questions:
        raise ValueError("选定的 split 没有公开问题")
    # LLM 子集在方法循环前固定一次，所有方法共享同一组问题。
    llm_subset = stratified_sample(
        questions,
        limit=config.llm_subset_limit,
        seed=config.seed,
    )
    llm_ids = {question.question_id for question in llm_subset}
    labels = _label_map(data, (question.question_id for question in questions))
    records: list[dict[str, object]] = []
    for method in config.methods:
        for question in questions:
            record_started = perf_counter()
            try:
                run = run_search(
                    question,
                    data.graph,
                    method,
                    config=config,
                    ga_weights=frozen.ga_weights,
                    classifier=frozen.classifier,
                    classifier_threshold=frozen.classifier_threshold,
                )
                label = labels[question.question_id]
                score = score_prediction(run.paths, label)
                record = _record_base(
                    question,
                    method,
                    run,
                    score,
                    elapsed_seconds=perf_counter() - record_started,
                    include_private_labels=config.include_private_labels,
                )
                if llm_scorer is not None and question.question_id in llm_ids:
                    request = LLMScoreRequest(
                        question,
                        method,
                        METHOD_LABELS[method],
                        run.answers,
                        run.paths,
                        run.stop_reasons,
                    )
                    try:
                        raw_llm = llm_scorer(request)
                        llm_score, detail, llm_error = _normalize_llm_score(raw_llm)
                        record["llm_score"] = llm_score
                        record["llm_score_detail"] = detail
                        record["llm_error"] = llm_error
                    except Exception as exc:  # noqa: BLE001 - 评分器故障不得改变搜索结果
                        record["llm_error"] = f"{type(exc).__name__}: {exc}"
                records.append(record)
            except Exception as exc:  # noqa: BLE001 - 逐题故障必须保留为实验记录
                label = labels.get(question.question_id)
                record = {
                    "question_id": question.question_id,
                    "set_name": question.set_name,
                    "split": question.split,
                    "layer": question.layer,
                    "family_id": question.family_id,
                    "kind": question.kind,
                    "min_hops": question.min_hops,
                    "max_hops": question.max_hops,
                    "direction": question.direction,
                    "method": method,
                    "method_label": METHOD_LABELS[method],
                    "predicted_answers": [],
                    "predicted_paths": [],
                    "predicted_answer_count": 0,
                    "predicted_path_count": 0,
                    "answer_correct": False,
                    "path_valid": False,
                    "path_complete": False,
                    "success": False,
                    "answer_precision": 0.0,
                    "answer_recall": 0.0,
                    "path_precision": 0.0,
                    "path_recall": 0.0,
                    "expanded_nodes": 0,
                    "candidate_checks": 0,
                    "reasoning_steps": 0,
                    "redundant_paths": 0,
                    "redundant_ratio": 0.0,
                    "search_elapsed_seconds": 0.0,
                    "elapsed_seconds": perf_counter() - record_started,
                    "search_stop_reasons": ["exception"],
                    "failure_reason": f"exception:{type(exc).__name__}",
                    "llm_score": None,
                    "llm_score_detail": None,
                    "llm_error": None,
                    "error": str(exc),
                }
                if config.include_private_labels and label is not None:
                    record["gold_answers"] = list(label.answers)
                    record["gold_paths"] = [list(path) for path in label.paths]
                    record["gold_answer_count"] = len(label.answers)
                    record["gold_path_count"] = len(label.paths)
                records.append(record)
    records.sort(key=lambda row: (row["split"], row["method"], row["question_id"]))
    aggregates: dict[str, object] = {}
    for split in SPLITS:
        split_records = [row for row in records if row["split"] == split]
        if not split_records:
            continue
        aggregates[split] = {
            method: _aggregate([row for row in split_records if row["method"] == method])
            for method in config.methods
        }
    aggregates["overall"] = {
        method: _aggregate([row for row in records if row["method"] == method])
        for method in config.methods
    }
    errors = sum("error" in row for row in records)
    fingerprints = _fingerprints(Path(data_dir) if data_dir is not None else None)
    summary: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "status": "complete" if errors == 0 else "complete_with_errors",
        "generated_at": datetime.now(UTC).isoformat(),
        "config": config.to_dict(),
        "protocol": _experiment_protocol(config),
        "method_labels": dict(METHOD_LABELS),
        "method_order": list(config.methods),
        "ablation_labels": dict(ABLATION_LABELS),
        "fingerprints": fingerprints,
        "fingerprint_digest": _fingerprint_payload(fingerprints),
        "fit": frozen.export_parameters(),
        "llm_subset": {
            "limit": config.llm_subset_limit,
            "question_ids": [q.question_id for q in llm_subset],
            "strata": {
                repr(key): value
                for key, value in sorted(
                    Counter(_question_stratum(q) for q in llm_subset).items(),
                    key=lambda item: repr(item[0]),
                )
            },
        },
        "question_counts": {
            split: sum(q.split == split for q in questions) for split in SPLITS
        },
        "question_ids": [question.question_id for question in questions],
        "record_count": len(records),
        "error_count": errors,
        "aggregates": aggregates,
        "outputs": {
            "summary": "summary.json",
            "config": "config.json",
            "fingerprints": "fingerprints.json",
            "parameters": "parameters.json",
            "protocol": "protocol.json",
            "metrics_csv": "metrics.csv",
            "records_jsonl": "records.jsonl",
            "records_csv": "records.csv",
            "freeze_manifest": "freeze_manifest.json",
            "report_table": "report_table.json",
            "report_markdown": "report_table.md",
        },
        "duration_seconds": perf_counter() - started,
    }
    return ExperimentResult(summary, tuple(records), frozen.export_parameters())


RECORD_COLUMNS = (
    "question_id",
    "set_name",
    "split",
    "layer",
    "family_id",
    "kind",
    "min_hops",
    "max_hops",
    "direction",
    "method",
    "method_label",
    "predicted_answers",
    "predicted_paths",
    "predicted_answer_count",
    "predicted_path_count",
    "answer_correct",
    "path_valid",
    "path_complete",
    "success",
    "answer_precision",
    "answer_recall",
    "path_precision",
    "path_recall",
    "expanded_nodes",
    "candidate_checks",
    "reasoning_steps",
    "redundant_paths",
    "redundant_ratio",
    "search_elapsed_seconds",
    "elapsed_seconds",
    "search_stop_reasons",
    "failure_reason",
    "llm_score",
    "llm_score_detail",
    "llm_error",
    "gold_answers",
    "gold_paths",
    "gold_answer_count",
    "gold_path_count",
    "error",
)


def _json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"


def _atomic_write(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def _csv_text(rows: Sequence[Mapping[str, object]], columns: Sequence[str]) -> str:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=list(columns), extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(
            {
                column: (
                    json.dumps(value, ensure_ascii=False, sort_keys=True)
                    if isinstance(value, (list, dict, tuple))
                    else value
                )
                for column, value in row.items()
            }
        )
    return buffer.getvalue()


def write_experiment_outputs(
    result: ExperimentResult,
    output_dir: str | Path,
    *,
    overwrite: bool = False,
) -> Path:
    """原子写出冻结结果；默认拒绝覆盖已有正式结果。"""

    root = Path(output_dir)
    if root.exists() and any(root.iterdir()) and not overwrite:
        raise FileExistsError(f"输出目录非空，拒绝覆盖: {root}")
    root.mkdir(parents=True, exist_ok=True)
    summary = dict(result.summary)
    payloads: dict[str, str] = {
        "summary.json": _json_text(summary),
        "config.json": _json_text(summary["config"]),
        "fingerprints.json": _json_text(summary["fingerprints"]),
        "parameters.json": _json_text(result.parameters),
        "protocol.json": _json_text(summary["protocol"]),
        "records.jsonl": "".join(
            json.dumps(row, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
            for row in result.records
        ),
        "records.csv": _csv_text(result.records, RECORD_COLUMNS),
    }
    metric_rows: list[dict[str, object]] = []
    aggregates = summary["aggregates"]
    for split, methods in aggregates.items():
        for method, metrics in methods.items():
            metric_rows.append({"split": split, "method": method, **dict(metrics)})
    metric_columns = (
        "split",
        "method",
        "questions",
        "answer_accuracy",
        "path_valid_rate",
        "path_complete_rate",
        "success_rate",
        "mean_expanded_nodes",
        "mean_candidate_checks",
        "mean_reasoning_steps",
        "mean_redundant_ratio",
        "total_elapsed_seconds",
        "mean_elapsed_seconds",
        "failure_reason_counts",
        "llm_scored",
        "mean_llm_score",
    )
    payloads["metrics.csv"] = _csv_text(metric_rows, metric_columns)
    report_rows = [
        {
            "split": split,
            "method": method,
            "method_label": METHOD_LABELS.get(method, method),
            "questions": metrics["questions"],
            "answer_accuracy": metrics["answer_accuracy"],
            "path_valid_rate": metrics["path_valid_rate"],
            "path_complete_rate": metrics["path_complete_rate"],
            "success_rate": metrics["success_rate"],
            "mean_expanded_nodes": metrics["mean_expanded_nodes"],
            "mean_candidate_checks": metrics["mean_candidate_checks"],
            "mean_reasoning_steps": metrics["mean_reasoning_steps"],
            "mean_redundant_ratio": metrics["mean_redundant_ratio"],
            "mean_elapsed_seconds": metrics["mean_elapsed_seconds"],
        }
        for split, methods in aggregates.items()
        for method, metrics in methods.items()
    ]
    payloads["report_table.json"] = _json_text(
        {
            "schema_version": SCHEMA_VERSION,
            "rows": report_rows,
            "ablation_labels": dict(ABLATION_LABELS),
        }
    )
    report_markdown = [
        "# CampusEcho KG 实验结果",
        "",
        "| split | method | questions | answer accuracy | path valid | path complete | success | mean expanded | mean checks | mean steps | redundant ratio | mean seconds |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    report_markdown.extend(
        "| {split} | {method_label} | {questions} | {answer_accuracy:.4f} | "
        "{path_valid_rate:.4f} | {path_complete_rate:.4f} | {success_rate:.4f} | "
        "{mean_expanded_nodes:.2f} | {mean_candidate_checks:.2f} | "
        "{mean_reasoning_steps:.2f} | {mean_redundant_ratio:.4f} | "
        "{mean_elapsed_seconds:.6f} |".format(**row)
        for row in report_rows
    )
    payloads["report_table.md"] = "\n".join(report_markdown) + "\n"
    for name, content in payloads.items():
        _atomic_write(root / name, content)
    freeze = {
        "schema_version": SCHEMA_VERSION,
        "frozen_at": datetime.now(UTC).isoformat(),
        "status": summary["status"],
        "files": {
            name: {
                "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest(),
                "bytes": (root / name).stat().st_size,
            }
            for name in sorted(payloads)
        },
    }
    _atomic_write(root / "freeze_manifest.json", _json_text(freeze))
    return root


__all__ = [
    "ABLATION_LABELS",
    "METHODS",
    "METHOD_LABELS",
    "SCHEMA_VERSION",
    "ExperimentConfig",
    "ExperimentResult",
    "FrozenParameters",
    "LLMScoreCallback",
    "LLMScoreRequest",
    "SearchMethod",
    "SearchRun",
    "fit_experiment_parameters",
    "run_experiment",
    "run_search",
    "score_prediction",
    "stratified_sample",
    "write_experiment_outputs",
]

