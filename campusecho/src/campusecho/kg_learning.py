"""知识图谱搜索的启发权重学习与路径价值分类。

本模块把搜索策略学习限制在四维、与实体编号无关的路径特征上。GA 只接收
搜索内核返回的统计结果；逻辑回归只接收训练分割中的特征和标签。两者都不
接受答案实体、测试标签或世界真值，便于在离线训练后冻结参数并部署。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import exp, isfinite
from numbers import Integral, Real
from pathlib import Path
from typing import Literal

import numpy as np

FEATURE_NAMES = (
    "goal_proximity",
    "evidence_support",
    "path_efficiency",
    "frontier_balance",
)
FEATURE_COUNT = len(FEATURE_NAMES)
_SPLITS = frozenset({"train", "val", "test"})


def _finite_float(value: Real, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{name} 必须是有限数值")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} 必须是有限数值")
    return result


def _positive_int(value: Integral, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise TypeError(f"{name} 必须是正整数")
    result = int(value)
    if result <= 0:
        raise ValueError(f"{name} 必须大于零")
    return result


def _nonnegative_int(value: Integral, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise TypeError(f"{name} 必须是整数")
    result = int(value)
    if result < 0:
        raise ValueError(f"{name} 必须非负")
    return result


def _feature_matrix(features: Iterable[Sequence[Real]], *, name: str = "features") -> np.ndarray:
    try:
        matrix = np.asarray(tuple(features), dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是形状为 (n, {FEATURE_COUNT}) 的数值矩阵") from exc
    if matrix.ndim != 2 or matrix.shape[1] != FEATURE_COUNT:
        raise ValueError(f"{name} 必须是形状为 (n, {FEATURE_COUNT}) 的数值矩阵")
    if not np.isfinite(matrix).all():
        raise ValueError(f"{name} 只能包含有限数值")
    return matrix


def _single_features(features: Sequence[Real], *, name: str = "features") -> np.ndarray:
    try:
        vector = np.asarray(features, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是长度为 {FEATURE_COUNT} 的数值向量") from exc
    if vector.shape != (FEATURE_COUNT,):
        raise ValueError(f"{name} 必须是长度为 {FEATURE_COUNT} 的数值向量")
    if not np.isfinite(vector).all():
        raise ValueError(f"{name} 只能包含有限数值")
    return vector


def normalize_heuristic_weights(weights: Sequence[Real]) -> np.ndarray:
    """把任意有限四维向量投影为非负且和为 1 的启发权重。"""
    vector = _single_features(weights, name="weights")
    clipped = np.maximum(vector, 0.0)
    total = float(clipped.sum())
    if total <= 0:
        raise ValueError("weights 至少需要一个正分量")
    return clipped / total


def weighted_heuristic_score(features: Sequence[Real], weights: Sequence[Real]) -> float:
    """计算搜索内核可直接使用的四特征加权启发分数。"""
    vector = _single_features(features)
    normalized = normalize_heuristic_weights(weights)
    return float(vector @ normalized)


@dataclass(frozen=True)
class SearchOutcome:
    """搜索内核只向 GA 暴露的聚合结果，不包含答案实体或测试标签。"""

    success: bool
    expanded_nodes: int
    steps: int

    def __post_init__(self) -> None:
        if not isinstance(self.success, bool):
            raise TypeError("success 必须是 bool")
        object.__setattr__(
            self,
            "expanded_nodes",
            _nonnegative_int(self.expanded_nodes, "expanded_nodes"),
        )
        object.__setattr__(self, "steps", _nonnegative_int(self.steps, "steps"))


@dataclass(frozen=True)
class HeuristicEvaluation:
    """一次权重评估的汇总；任务结果按输入顺序保存以支持确定性重放。"""

    mean_success_rate: float
    mean_expanded_nodes: float
    mean_steps: float
    outcomes: tuple[SearchOutcome, ...]

    @property
    def fitness(self) -> tuple[float, float, float]:
        """按成功率、扩展节点数、步数依次比较的字典序适应度。"""
        return (self.mean_success_rate, -self.mean_expanded_nodes, -self.mean_steps)


@dataclass(frozen=True)
class GAConfig:
    population_size: int = 24
    generations: int = 30
    seeds: tuple[int, ...] = (0, 1, 2)
    tournament_size: int = 3
    crossover_rate: float = 0.8
    mutation_rate: float = 0.2
    mutation_scale: float = 0.15
    elite_count: int = 2

    def __post_init__(self) -> None:
        for name in ("population_size", "generations", "tournament_size", "elite_count"):
            object.__setattr__(self, name, _positive_int(getattr(self, name), name))
        seeds = tuple(self.seeds)
        if not seeds:
            raise ValueError("seeds 不能为空")
        normalized_seeds = tuple(_nonnegative_int(seed, "seed") for seed in seeds)
        if len(set(normalized_seeds)) != len(normalized_seeds):
            raise ValueError("seeds 不能重复")
        object.__setattr__(self, "seeds", normalized_seeds)
        if self.tournament_size > self.population_size:
            raise ValueError("tournament_size 不能大于 population_size")
        if self.elite_count > self.population_size:
            raise ValueError("elite_count 不能大于 population_size")
        for name in ("crossover_rate", "mutation_rate"):
            value = _finite_float(getattr(self, name), name)
            if not 0 <= value <= 1:
                raise ValueError(f"{name} 必须位于 [0, 1]")
            object.__setattr__(self, name, value)
        scale = _finite_float(self.mutation_scale, "mutation_scale")
        if scale < 0:
            raise ValueError("mutation_scale 必须非负")
        object.__setattr__(self, "mutation_scale", scale)


@dataclass(frozen=True)
class GAResult:
    """GA 的冻结输出；best_weights 已经过非负归一化。"""

    best_weights: np.ndarray
    best_fitness: tuple[float, float, float]
    initial_weights: np.ndarray
    generation_best_fitness: tuple[tuple[float, float, float], ...]
    seed_results: tuple[HeuristicEvaluation, ...]
    config: GAConfig

    def __post_init__(self) -> None:
        weights = normalize_heuristic_weights(self.best_weights)
        weights.setflags(write=False)
        object.__setattr__(self, "best_weights", weights)
        initial = normalize_heuristic_weights(self.initial_weights)
        initial.setflags(write=False)
        object.__setattr__(self, "initial_weights", initial)

    def export_parameters(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "feature_names": list(FEATURE_NAMES),
            "weights": self.best_weights.tolist(),
            "initial_weights": self.initial_weights.tolist(),
            "best_fitness": list(self.best_fitness),
            "generation_best_fitness": [list(item) for item in self.generation_best_fitness],
            "config": {
                "population_size": self.config.population_size,
                "generations": self.config.generations,
                "seeds": list(self.config.seeds),
                "tournament_size": self.config.tournament_size,
                "crossover_rate": self.config.crossover_rate,
                "mutation_rate": self.config.mutation_rate,
                "mutation_scale": self.config.mutation_scale,
                "elite_count": self.config.elite_count,
            },
        }

    def score(self, features: Sequence[Real]) -> float:
        """使用冻结权重给候选路径打分。"""
        return weighted_heuristic_score(features, self.best_weights)


FeatureExtractor = Callable[[Sequence[float]], Sequence[float]]


class HeuristicGA:
    """可复现的四特征启发权重搜索器。

    ``feature_extractor`` 接收候选路径的原始特征，返回四维特征；
    ``evaluate`` 接收归一化权重和特征提取器，并返回聚合搜索统计。
    这种注入方式让真实搜索内核负责路径枚举，而本类不读取答案实体。
    """

    def __init__(
        self,
        feature_extractor: FeatureExtractor,
        evaluate: Callable[[np.ndarray, FeatureExtractor], SearchOutcome | Iterable[SearchOutcome]],
        *,
        config: GAConfig | None = None,
    ) -> None:
        if not callable(feature_extractor):
            raise TypeError("feature_extractor 必须可调用")
        if not callable(evaluate):
            raise TypeError("evaluate 必须可调用")
        self.feature_extractor = feature_extractor
        self.evaluate = evaluate
        self.config = config or GAConfig()

    def extract_features(self, raw_features: Sequence[float]) -> np.ndarray:
        return _single_features(self.feature_extractor(raw_features), name="提取特征")

    def _evaluate_weights(self, weights: np.ndarray) -> HeuristicEvaluation:
        outcomes = self.evaluate(weights.copy(), self.feature_extractor)
        if isinstance(outcomes, SearchOutcome):
            outcome_tuple = (outcomes,)
        else:
            try:
                outcome_tuple = tuple(outcomes)
            except TypeError as exc:
                raise TypeError("evaluate 必须返回 SearchOutcome 或其可迭代对象") from exc
        if not outcome_tuple or any(not isinstance(item, SearchOutcome) for item in outcome_tuple):
            raise ValueError("evaluate 必须返回至少一个 SearchOutcome")
        success_rate = sum(item.success for item in outcome_tuple) / len(outcome_tuple)
        expanded = sum(item.expanded_nodes for item in outcome_tuple) / len(outcome_tuple)
        steps = sum(item.steps for item in outcome_tuple) / len(outcome_tuple)
        return HeuristicEvaluation(success_rate, expanded, steps, outcome_tuple)

    @staticmethod
    def _tournament(
        population: np.ndarray,
        scores: Sequence[tuple[float, float, float]],
        rng: np.random.Generator,
        size: int,
    ) -> np.ndarray:
        indices = rng.choice(len(population), size=size, replace=False)
        winner = max(indices.tolist(), key=lambda index: scores[index])
        return population[winner].copy()

    def _run_seed(
        self, seed: int
    ) -> tuple[
        np.ndarray,
        np.ndarray,
        HeuristicEvaluation,
        tuple[tuple[float, float, float], ...],
    ]:
        rng = np.random.default_rng(seed)
        population = rng.dirichlet(np.ones(FEATURE_COUNT), size=self.config.population_size)
        initial_weights = population[0].copy()
        best_weights = population[0].copy()
        best_evaluation: HeuristicEvaluation | None = None
        best_fitness: tuple[float, float, float] | None = None
        generation_best: list[tuple[float, float, float]] = []
        for _ in range(self.config.generations):
            evaluations = [self._evaluate_weights(weights) for weights in population]
            scores = [item.fitness for item in evaluations]
            order = sorted(range(len(population)), key=lambda index: scores[index], reverse=True)
            if best_fitness is None or scores[order[0]] > best_fitness:
                best_fitness = scores[order[0]]
                best_evaluation = evaluations[order[0]]
                best_weights = population[order[0]].copy()
            generation_best.append(best_fitness)
            next_population = [
                population[index].copy() for index in order[: self.config.elite_count]
            ]
            while len(next_population) < self.config.population_size:
                parent_a = self._tournament(population, scores, rng, self.config.tournament_size)
                parent_b = self._tournament(population, scores, rng, self.config.tournament_size)
                if rng.random() < self.config.crossover_rate:
                    mask = rng.random(FEATURE_COUNT) < 0.5
                    child = np.where(mask, parent_a, parent_b)
                else:
                    child = parent_a
                if rng.random() < self.config.mutation_rate:
                    child = child + rng.normal(0.0, self.config.mutation_scale, FEATURE_COUNT)
                child = np.maximum(child, 0.0)
                if child.sum() <= 0:
                    child = parent_a
                next_population.append(normalize_heuristic_weights(child))
            population = np.asarray(next_population, dtype=float)
        if best_evaluation is None or best_fitness is None:
            raise RuntimeError("GA 至少需要评估一代")
        return (
            normalize_heuristic_weights(best_weights),
            normalize_heuristic_weights(initial_weights),
            best_evaluation,
            tuple(generation_best),
        )

    def fit(self) -> GAResult:
        seed_weights: list[np.ndarray] = []
        initial_weights: list[np.ndarray] = []
        seed_evaluations: list[HeuristicEvaluation] = []
        histories: list[tuple[tuple[float, float, float], ...]] = []
        for seed in self.config.seeds:
            weights, initial, evaluation, history = self._run_seed(seed)
            seed_weights.append(weights)
            initial_weights.append(initial)
            seed_evaluations.append(evaluation)
            histories.append(history)
        best_seed = max(
            range(len(seed_evaluations)), key=lambda index: seed_evaluations[index].fitness
        )
        return GAResult(
            seed_weights[best_seed],
            seed_evaluations[best_seed].fitness,
            initial_weights[best_seed],
            histories[best_seed],
            tuple(seed_evaluations),
            self.config,
        )


@dataclass(frozen=True)
class PathSample:
    """路径价值分类器的单条训练/推理样本。

    特征必须由搜索内核从可见结构提取；本类不提供实体 ID 字段。
    split 用于训练边界校验，推理时标签必须为 None。
    """

    features: tuple[float, ...]
    label: bool | None = None
    split: Literal["train", "val", "test"] | None = None

    def __post_init__(self) -> None:
        vector = _single_features(self.features)
        object.__setattr__(self, "features", tuple(float(value) for value in vector))
        if self.label is not None and not isinstance(self.label, bool):
            raise TypeError("label 必须是 bool 或 None")
        if self.split is not None and self.split not in _SPLITS:
            raise ValueError("split 必须是 train、val、test 或 None")


class PathValueClassifier:
    """带 L2 正则的 L2 逻辑回归路径价值分类器。"""

    def __init__(
        self,
        weights: Sequence[Real],
        bias: Real,
        *,
        mean: Sequence[Real] = (0.0,) * FEATURE_COUNT,
        scale: Sequence[Real] = (1.0,) * FEATURE_COUNT,
    ) -> None:
        self.weights = _single_features(weights, name="weights")
        self.bias = _finite_float(bias, "bias")
        self.mean = _single_features(mean, name="mean")
        self.scale = _single_features(scale, name="scale")
        if np.any(self.scale <= 0):
            raise ValueError("scale 必须全部大于零")

    def _transform(self, features: Sequence[Real]) -> np.ndarray:
        return (_single_features(features) - self.mean) / self.scale

    def predict_proba(self, features: Sequence[Real]) -> float:
        logit = float(self._transform(features) @ self.weights + self.bias)
        if logit >= 0:
            return 1.0 / (1.0 + exp(-logit))
        exp_logit = exp(logit)
        return exp_logit / (1.0 + exp_logit)

    def predict(self, features: Sequence[Real], *, threshold: float = 0.5) -> bool:
        cutoff = _finite_float(threshold, "threshold")
        if not 0 < cutoff < 1:
            raise ValueError("threshold 必须位于 (0, 1)")
        return self.predict_proba(features) >= cutoff

    def export_parameters(self) -> dict[str, object]:
        return {
            "schema_version": 1,
            "feature_names": list(FEATURE_NAMES),
            "weights": self.weights.tolist(),
            "bias": self.bias,
            "mean": self.mean.tolist(),
            "scale": self.scale.tolist(),
        }

    @classmethod
    def from_parameters(cls, parameters: Mapping[str, object]) -> PathValueClassifier:
        if not isinstance(parameters, Mapping):
            raise TypeError("parameters 必须是映射")
        required = {"schema_version", "feature_names", "weights", "bias", "mean", "scale"}
        missing = required - set(parameters)
        if missing:
            raise ValueError(f"分类器参数缺少字段: {', '.join(sorted(missing))}")
        schema_version = parameters["schema_version"]
        if isinstance(schema_version, bool) or schema_version != 1:
            raise ValueError("不支持的分类器 schema_version")
        if tuple(parameters.get("feature_names", ())) != FEATURE_NAMES:
            raise ValueError("分类器特征名或顺序不匹配")
        return cls(
            parameters["weights"],
            parameters["bias"],
            mean=parameters["mean"],
            scale=parameters["scale"],
        )

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(self.export_parameters(), ensure_ascii=False, sort_keys=True, indent=2)
            + "\n",
            encoding="utf-8",
        )

    @classmethod
    def load(cls, path: str | Path) -> PathValueClassifier:
        return cls.from_parameters(json.loads(Path(path).read_text(encoding="utf-8")))

    @classmethod
    def fit(
        cls,
        samples: Iterable[PathSample],
        *,
        l2: float = 1e-2,
        learning_rate: float = 0.2,
        epochs: int = 600,
    ) -> PathValueClassifier:
        """使用稳定 sigmoid 与全批量梯度下降训练。

        只允许显式标注为 train 的样本进入训练；val/test 标签在读取特征前
        即被拒绝，防止调用方误把评估集送入学习。
        """
        regularization = _finite_float(l2, "l2")
        rate = _finite_float(learning_rate, "learning_rate")
        iterations = _positive_int(epochs, "epochs")
        if regularization < 0:
            raise ValueError("l2 必须非负")
        if rate <= 0:
            raise ValueError("learning_rate 必须大于零")
        records = tuple(samples)
        if not records:
            raise ValueError("训练样本不能为空")
        if any(not isinstance(item, PathSample) for item in records):
            raise TypeError("samples 必须由 PathSample 组成")
        if any(item.split != "train" for item in records):
            raise ValueError("fit 只能使用 split=train 的样本")
        if any(item.label is None for item in records):
            raise ValueError("训练样本必须提供标签")
        matrix = _feature_matrix(item.features for item in records)
        labels = np.asarray([int(item.label) for item in records], dtype=float)
        if len(np.unique(labels)) < 2:
            raise ValueError("训练样本必须同时包含正负类")
        mean = matrix.mean(axis=0)
        scale = matrix.std(axis=0)
        scale[scale < 1e-12] = 1.0
        design = (matrix - mean) / scale
        weights = np.zeros(FEATURE_COUNT)
        bias = 0.0
        for _ in range(iterations):
            logits = design @ weights + bias
            probabilities = np.where(
                logits >= 0,
                1.0 / (1.0 + np.exp(-np.abs(logits))),
                np.exp(-np.abs(logits)) / (1.0 + np.exp(-np.abs(logits))),
            )
            residual = probabilities - labels
            gradient_w = design.T @ residual / len(records) + regularization * weights
            gradient_b = float(residual.mean())
            weights -= rate * gradient_w
            bias -= rate * gradient_b
        return cls(weights, bias, mean=mean, scale=scale)


def fit_heuristic_and_classifier(
    feature_extractor: FeatureExtractor,
    evaluate: Callable[[np.ndarray, FeatureExtractor], SearchOutcome | Iterable[SearchOutcome]],
    train_samples: Iterable[PathSample],
    *,
    ga_config: GAConfig | None = None,
    classifier_options: Mapping[str, object] | None = None,
) -> tuple[GAResult, PathValueClassifier]:
    """供主代理一次完成 GA 与分类器训练的组合入口。"""
    ga = HeuristicGA(feature_extractor, evaluate, config=ga_config).fit()
    classifier = PathValueClassifier.fit(train_samples, **dict(classifier_options or {}))
    return ga, classifier


def feature_contract_digest() -> str:
    """返回特征契约摘要，便于训练产物与搜索内核版本一起审计。"""
    payload = json.dumps(FEATURE_NAMES, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
