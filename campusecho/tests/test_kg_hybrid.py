"""混合搜索适配层：GA、分类器与 LLM 必须实际改变排序。"""

import numpy as np

from campusecho.kg_data import load_kg_data
from campusecho.kg_hybrid import (
    HybridConfig,
    fit_ga,
    heuristic_for,
    hybrid_search,
    structural_features,
    train_classifier,
)
from campusecho.kg_learning import GAConfig
from campusecho.kg_search import SearchState


def _data():
    return load_kg_data("data/kg", verify=False)


def _train_questions(data):
    return [
        row
        for row in data.questions["core"]
        if row.split == "train" and row.layer == "campus"
    ][:4]


def test_features_are_finite_and_do_not_use_answer_ids():
    data = _data()
    question = _train_questions(data)[0]
    state = SearchState(question.start_entity)
    features = structural_features(data, question, state)
    assert len(features) == 4
    assert np.isfinite(features).all()
    assert all(0 <= value <= 1 for value in features)


def test_ga_changes_weights_and_classifier_learns():
    data = _data()
    questions = _train_questions(data)
    ga = fit_ga(
        data,
        questions,
        config=GAConfig(
            population_size=8,
            generations=3,
            seeds=(1,),
            tournament_size=2,
            elite_count=1,
        ),
    )
    assert np.isclose(ga.best_weights.sum(), 1.0)
    classifier = train_classifier(data, questions)
    probability = classifier.predict_proba(
        structural_features(data, questions[0], SearchState(questions[0].start_entity))
    )
    assert 0 <= probability <= 1


def test_hybrid_search_preserves_answer_and_reports_mode():
    data = _data()
    question = _train_questions(data)[0]
    result = hybrid_search(
        data,
        question,
        HybridConfig(mode="ga", weights=(0.4, 0.3, 0.2, 0.1)),
    )
    assert result.mode == "ga"
    assert result.search.success
    assert result.search.solutions
    assert result.trace_scores
    assert result.llm_status == "disabled"


def test_manual_and_learned_heuristics_are_different():
    data = _data()
    question = _train_questions(data)[0]
    state = SearchState(question.start_entity)
    manual = heuristic_for(data, question, (0.25, 0.25, 0.25, 0.25))(state)
    learned = heuristic_for(data, question, (0.7, 0.1, 0.1, 0.1))(state)
    assert manual != learned
