"""GA 启发权重与路径价值分类器的独立行为测试。"""

import json

import numpy as np
import pytest

from campusecho.kg_learning import (
    FEATURE_COUNT,
    FEATURE_NAMES,
    GAConfig,
    HeuristicEvaluation,
    HeuristicGA,
    PathSample,
    PathValueClassifier,
    SearchOutcome,
    feature_contract_digest,
    normalize_heuristic_weights,
    weighted_heuristic_score,
)


def _synthetic_outcome(weights):
    # 只有第一维高权重时才成功；节点数与步数由其余权重决定。
    success = bool(weights[0] > 0.55)
    return SearchOutcome(success, 20 + int(100 * weights[1]), 10 + int(100 * weights[2]))


def _identity_extractor(raw):
    return raw


def _fit_small_ga():
    config = GAConfig(
        population_size=10,
        generations=4,
        seeds=(7, 11),
        tournament_size=3,
        elite_count=2,
        mutation_rate=0.5,
    )
    return HeuristicGA(
        _identity_extractor, lambda weights, _: _synthetic_outcome(weights), config=config
    ).fit()


def test_weight_normalization_is_nonnegative_and_unit_sum():
    weights = normalize_heuristic_weights((-2.0, 0.0, 3.0, 1.0))
    assert weights.shape == (FEATURE_COUNT,)
    assert np.all(weights >= 0)
    assert weights.sum() == pytest.approx(1.0)
    assert weights.tolist() == pytest.approx([0.0, 0.0, 0.75, 0.25])
    with pytest.raises(ValueError):
        normalize_heuristic_weights((0, 0, 0, 0))
    assert weighted_heuristic_score((1, 2, 3, 4), (1, 1, 1, 1)) == pytest.approx(2.5)


def test_fitness_prioritizes_success_rate_lexicographically():
    failed = HeuristicEvaluation(0.0, 1.0, 1.0, (SearchOutcome(False, 1, 1),))
    succeeded = HeuristicEvaluation(
        1.0, 1_000_000.0, 1_000_000.0, (SearchOutcome(True, 1_000_000, 1_000_000),)
    )
    assert succeeded.fitness > failed.fitness


def test_ga_is_deterministic_and_changes_initial_weights():
    first = _fit_small_ga()
    second = _fit_small_ga()
    assert np.array_equal(first.best_weights, second.best_weights)
    assert first.generation_best_fitness == second.generation_best_fitness
    assert first.best_weights[0] > 0.5
    assert not np.allclose(first.best_weights, [0.25] * FEATURE_COUNT)
    assert not np.allclose(first.best_weights, first.initial_weights)
    assert first.best_weights.sum() == pytest.approx(1.0)
    assert first.best_weights.flags.writeable is False


def test_ga_rejects_invalid_search_outcomes_and_config():
    with pytest.raises(ValueError):
        SearchOutcome(True, -1, 1)
    with pytest.raises(TypeError):
        SearchOutcome(1, 1, 1)
    with pytest.raises(ValueError):
        GAConfig(seeds=(1, 1))
    with pytest.raises(ValueError):
        GAConfig(population_size=2, tournament_size=3)
    with pytest.raises(ValueError):
        GAConfig(mutation_rate=1.1)
    assert GAConfig().seeds == (0, 1, 2)
    assert GAConfig().population_size == 24
    assert GAConfig().generations == 30
    assert SearchOutcome(True, 0, 0).expanded_nodes == 0


def test_ga_rejects_evaluator_that_returns_no_outcomes():
    ga = HeuristicGA(
        _identity_extractor,
        lambda _weights, _extract: (),
        config=GAConfig(
            population_size=3, generations=1, seeds=(1,), tournament_size=2, elite_count=1
        ),
    )
    with pytest.raises(ValueError):
        ga.fit()


def _classification_samples():
    positive = [
        (1.0, 0.9, 0.8, 0.2),
        (0.9, 0.8, 0.7, 0.1),
        (0.8, 0.7, 0.9, 0.3),
        (1.1, 0.8, 0.8, 0.2),
    ]
    negative = [
        (0.1, 0.2, 0.2, 0.8),
        (0.2, 0.1, 0.3, 0.9),
        (0.0, 0.3, 0.1, 0.7),
        (0.2, 0.2, 0.2, 1.0),
    ]
    return [
        *(PathSample(values, True, "train") for values in positive),
        *(PathSample(values, False, "train") for values in negative),
    ]


def test_classifier_learns_and_round_trips_parameters(tmp_path):
    model = PathValueClassifier.fit(
        _classification_samples(), l2=0.001, learning_rate=0.3, epochs=800
    )
    assert model.predict_proba((1.0, 0.9, 0.8, 0.2)) > 0.8
    assert model.predict_proba((0.1, 0.2, 0.2, 0.8)) < 0.2
    samples = _classification_samples()
    assert all(model.predict(sample.features) == sample.label for sample in samples)
    assert model.predict((1.0, 0.9, 0.8, 0.2))
    assert not model.predict((0.1, 0.2, 0.2, 0.8))
    path = tmp_path / "path_classifier.json"
    model.save(path)
    restored = PathValueClassifier.load(path)
    assert restored.export_parameters() == model.export_parameters()
    assert restored.predict_proba((1.0, 0.9, 0.8, 0.2)) == pytest.approx(
        model.predict_proba((1.0, 0.9, 0.8, 0.2))
    )


def test_classifier_rejects_test_split_before_training():
    samples = _classification_samples()
    samples.append(PathSample((0.5, 0.5, 0.5, 0.5), True, "test"))
    with pytest.raises(ValueError, match="train"):
        PathValueClassifier.fit(samples)


def test_classifier_validates_feature_and_parameter_boundaries():
    with pytest.raises(ValueError):
        PathSample((1.0, 2.0), True, "train")
    with pytest.raises(ValueError):
        PathSample((1.0, 2.0, 3.0, float("nan")), True, "train")
    with pytest.raises(ValueError):
        PathSample((1.0, 2.0, 3.0, 4.0), True, "unknown")
    with pytest.raises(ValueError):
        PathValueClassifier.fit([PathSample((0.1, 0.1, 0.1, 0.1), False, "train")] * 4)
    model = PathValueClassifier((1, 0, 0, 0), 0)
    with pytest.raises(ValueError):
        model.predict((1, 2, 3, 4), threshold=1.0)
    with pytest.raises(ValueError):
        PathValueClassifier.from_parameters({"schema_version": 1})
    with pytest.raises(ValueError):
        PathValueClassifier((1, 0, 0, 0), 0, scale=(1, 1, 0, 1))


def test_public_contract_has_no_entity_or_label_inputs():
    assert FEATURE_NAMES == (
        "goal_proximity",
        "evidence_support",
        "path_efficiency",
        "frontier_balance",
    )
    assert len(feature_contract_digest()) == 64
    result = _fit_small_ga()
    exported = json.dumps(result.export_parameters(), ensure_ascii=False)
    assert "entity" not in exported.lower()
    assert "label" not in exported.lower()
    assert "entity" not in PathSample.__dataclass_fields__
    assert "id" not in PathSample.__dataclass_fields__
    assert set(result.export_parameters()) == {
        "schema_version",
        "feature_names",
        "weights",
        "initial_weights",
        "best_fitness",
        "generation_best_fitness",
        "config",
    }
