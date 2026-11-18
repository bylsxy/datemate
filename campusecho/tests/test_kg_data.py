"""知识图谱 schema、来源、划分、问题穷举与公开/私有隔离。"""

import hashlib
import json
from dataclasses import replace

import pytest

from campusecho.kg_data import (
    AnswerLabel,
    Entity,
    GenerationConfig,
    KnowledgeGraph,
    QuestionPublic,
    SourceRecord,
    generate_kg_data,
    load_kg_data,
    verify_labels,
    write_kg_data,
)


@pytest.fixture(scope="module")
def generated():
    return generate_kg_data(
        GenerationConfig(
            seed=71,
            campus_families=5,
            questions_per_family=5,
            robust_per_family=2,
        )
    )


def test_default_generation_scale_sources_and_public_private_projection():
    data = generate_kg_data()
    assert len(data.graph.entities) == 504
    assert len(data.graph.triples) == 1234
    assert len(data.questions["core"]) == 662
    assert len(data.questions["robust"]) == 112
    assert data.manifest["academic_sources_verified"] is True
    assert data.manifest["retrieved_at"] == "2026-11-18"
    assert data.manifest["campus_layer"].startswith("fictional")
    public = data.public_questions("core")
    assert public == data.questions["core"]
    assert not hasattr(public[0], "answers")
    assert not hasattr(public[0], "paths")
    assert set(data.labels) == {"core", "robust"}
    assert all(label.question_id for label in data.private_labels("robust"))


def test_schema_roundtrip_and_strict_unknown_fields(generated):
    graph = KnowledgeGraph.from_dict(generated.graph.to_dict())
    assert graph == generated.graph
    question = QuestionPublic.from_dict(generated.questions["core"][0].to_dict())
    assert question == generated.questions["core"][0]
    label = AnswerLabel.from_dict(generated.labels["core"][0].to_dict())
    assert label == generated.labels["core"][0]
    with pytest.raises(ValueError, match="未知字段"):
        Entity.from_dict({**generated.graph.entities[0].to_dict(), "extra": 1})
    with pytest.raises(ValueError, match="schema"):
        KnowledgeGraph.from_dict({**generated.graph.to_dict(), "schema_version": 2})


def test_duplicate_edge_and_unknown_relation_are_rejected(generated):
    graph = generated.graph
    duplicate = replace(
        graph.triples[-1], triple_id=f"{graph.triples[-1].triple_id}:duplicate"
    )
    with pytest.raises(ValueError, match="重复边"):
        KnowledgeGraph(graph.sources, graph.entities, (*graph.triples, duplicate))
    with pytest.raises(ValueError, match="未知关系"):
        replace(graph.triples[0], relation="UNKNOWN_RELATION")


def test_alias_resolution_is_unique_and_conflicts_are_rejected(generated):
    graph = generated.graph
    with_alias = next(entity for entity in graph.entities if entity.aliases)
    assert graph.resolve_alias(with_alias.aliases[0]) == with_alias.entity_id
    other = next(
        entity
        for entity in graph.entities
        if entity.entity_id != with_alias.entity_id
        and with_alias.aliases[0] not in (entity.name, *entity.aliases)
    )
    conflicting = replace(other, aliases=(*other.aliases, with_alias.aliases[0]))
    entities = tuple(
        conflicting if entity.entity_id == other.entity_id else entity
        for entity in graph.entities
    )
    with pytest.raises(ValueError, match="别名冲突"):
        KnowledgeGraph(graph.sources, entities, graph.triples)


def test_family_split_has_no_leakage_and_60_20_20_target(generated):
    family_splits = generated.manifest["family_splits"]
    assert set(family_splits.values()) == {"train", "val", "test"}
    question_families = {
        split: {
            question.family_id
            for question in (*generated.questions["core"], *generated.questions["robust"])
            if question.split == split
        }
        for split in ("train", "val", "test")
    }
    assert not question_families["train"] & question_families["val"]
    assert not question_families["train"] & question_families["test"]
    assert not question_families["val"] & question_families["test"]
    for question in (*generated.questions["core"], *generated.questions["robust"]):
        assert family_splits[question.family_id] == question.split
    default_ratios = generate_kg_data().manifest["split_ratios"]
    assert abs(default_ratios["val"] - 0.2) <= 0.05
    assert abs(default_ratios["test"] - 0.2) <= 0.05
    assert abs(default_ratios["train"] - 0.6) <= 0.05


def test_questions_are_two_to_four_hops_and_labels_are_exhaustive(generated):
    for set_name in ("core", "robust"):
        verify_labels(
            generated.graph, generated.questions, generated.labels
        )
        for question in generated.questions[set_name]:
            assert 2 <= question.min_hops <= question.max_hops <= 4
            label = next(
                row for row in generated.labels[set_name]
                if row.question_id == question.question_id
            )
            assert all(2 <= hops <= 4 for hops in label.hop_lengths)


def test_unsolvable_and_multipath_examples_are_present(generated):
    labels = [
        label for rows in generated.labels.values() for label in rows
    ]
    assert any(not label.solvable for label in labels)
    assert any(len(label.paths) > 1 for label in labels)
    unsolvable = next(label for label in labels if not label.solvable)
    assert unsolvable.answers == unsolvable.paths == unsolvable.hop_lengths == ()


def test_visibility_changes_active_edges(generated):
    graph = generated.graph
    hidden = next(
        triple
        for triple in graph.triples
        if triple.layer == "campus" and triple.visible_from > "2026-01-01"
    )
    assert hidden not in graph.active_triples("2026-01-01")
    assert hidden in graph.active_triples("2026-11-18")


def test_source_type_whitelist_is_enforced(generated):
    graph = generated.graph
    triple = next(
        row for row in graph.triples if row.layer == "campus"
    )
    academic_source = next(
        source
        for source in graph.sources
        if source.source_type == "paper"
    )
    with pytest.raises(ValueError, match="来源图层"):
        KnowledgeGraph(
            graph.sources,
            graph.entities,
            tuple(
                replace(row, source_ids=(academic_source.source_id,))
                if row.triple_id == triple.triple_id
                else row
                for row in graph.triples
            ),
        )


    fictional_source = next(
        source
        for source in graph.sources
        if source.source_type == "fictional"
    )
    with pytest.raises(ValueError, match="来源图层"):
        KnowledgeGraph(
            graph.sources,
            graph.entities,
            tuple(
                replace(row, source_ids=(fictional_source.source_id,))
                if row.layer == "academic"
                else row
                for row in graph.triples
            ),
        )


def test_source_record_rejects_invalid_layer_type_pair():
    with pytest.raises(ValueError, match="来源类型与图层"):
        SourceRecord(
            "source:bad",
            "campus",
            "paper",
            "invalid",
            "https://example.com/paper",
            "2026-11-18",
            "invalid fixture",
        )


def test_file_roundtrip_hashes_and_public_file_contains_no_answers(tmp_path, generated):
    manifest = write_kg_data(
        tmp_path,
        generated.graph,
        generated.questions,
        generated.labels,
        generated.manifest,
    )
    loaded = load_kg_data(tmp_path)
    assert loaded.graph == generated.graph
    assert loaded.questions == generated.questions
    assert loaded.labels == generated.labels
    public_text = (tmp_path / "questions_public.jsonl").read_text(encoding="utf-8")
    private_text = (tmp_path / "answers_private.jsonl").read_text(encoding="utf-8")
    assert '"answers"' not in public_text
    assert '"paths"' not in public_text
    assert '"answers"' in private_text
    for name, entry in manifest["files"].items():
        assert hashlib.sha256((tmp_path / name).read_bytes()).hexdigest() == entry[
            "sha256"
        ]


def test_tampered_private_answer_is_rejected(tmp_path, generated):
    write_kg_data(
        tmp_path,
        generated.graph,
        generated.questions,
        generated.labels,
        generated.manifest,
    )
    path = tmp_path / "answers_private.jsonl"
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
    ]
    rows[0]["answers"] = ["tampered"]
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="指纹"):
        load_kg_data(tmp_path)


def test_label_cannot_claim_a_different_path_or_answer(generated):
    label = generated.labels["core"][0]
    with pytest.raises(ValueError):
        replace(label, answers=("not-an-answer",))
    with pytest.raises(ValueError):
        replace(label, hop_lengths=(1,))


def test_generation_is_seeded_and_small_config_is_valid():
    config = GenerationConfig(
        seed=9,
        campus_families=3,
        questions_per_family=3,
        robust_per_family=2,
    )
    assert generate_kg_data(config) == generate_kg_data(config)
    assert generate_kg_data(config) != generate_kg_data(
        replace(config, questions_per_family=4)
    )
