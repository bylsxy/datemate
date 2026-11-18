"""CampusEcho 的可审计知识图谱数据层。

学术层只收录可从 arXiv 原文元数据和 OpenAlex 记录核对的论文事实；校园层全部
标记为虚构。公开问题文件不包含答案，私有标注文件只供评测器读取。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from types import MappingProxyType

SCHEMA_VERSION = 1
LAYERS = ("academic", "campus")
SPLITS = ("train", "val", "test")
SOURCE_TYPES = ("paper", "openalex_metadata", "fictional")
QUESTION_SETS = ("core", "robust")
QUESTION_KINDS = (
    "core",
    "alias",
    "paraphrase",
    "unsolvable",
    "multipath",
    "visibility",
    "reverse",
    "relation_chain",
    "generalized",
)
DIRECTIONS = ("out", "in")
ANSWER_TYPE = "entity_set"

ENTITY_TYPES = {
    "academic": {
        "paper",
        "model",
        "method",
        "dataset",
        "modality",
        "venue",
        "publisher",
        "topic",
        "field",
        "person",
    },
    "campus": {"person", "club", "event", "place", "zone"},
}


@dataclass(frozen=True)
class RelationSpec:
    layer: str
    pairs: tuple[tuple[str, str], ...]
    source_types: tuple[str, ...]


RELATION_SPECS = {
    "INTRODUCES": RelationSpec(
        "academic", (("paper", "model"),), ("paper", "openalex_metadata")
    ),
    "USES": RelationSpec(
        "academic", (("model", "method"),), ("paper", "openalex_metadata")
    ),
    "EVALUATED_ON": RelationSpec(
        "academic", (("paper", "dataset"),), ("paper", "openalex_metadata")
    ),
    "HAS_MODALITY": RelationSpec(
        "academic", (("dataset", "modality"),), ("paper", "openalex_metadata")
    ),
    "PUBLISHED_AT": RelationSpec(
        "academic", (("paper", "venue"),), ("paper", "openalex_metadata")
    ),
    "PUBLISHED_BY": RelationSpec(
        "academic", (("venue", "publisher"),), ("paper", "openalex_metadata")
    ),
    "ABOUT": RelationSpec(
        "academic", (("paper", "topic"),), ("paper", "openalex_metadata")
    ),
    "PART_OF": RelationSpec(
        "academic", (("topic", "field"),), ("paper", "openalex_metadata")
    ),
    "AUTHORED_BY": RelationSpec(
        "academic", (("person", "paper"),), ("paper", "openalex_metadata")
    ),
    "MEMBER_OF": RelationSpec("campus", (("person", "club"),), ("fictional",)),
    "ADVISES": RelationSpec("campus", (("person", "club"),), ("fictional",)),
    "ORGANIZES": RelationSpec("campus", (("club", "event"),), ("fictional",)),
    "HELD_AT": RelationSpec("campus", (("event", "place"),), ("fictional",)),
    "LOCATED_IN": RelationSpec("campus", (("place", "zone"),), ("fictional",)),
    "ATTENDS": RelationSpec("campus", (("person", "event"),), ("fictional",)),
    "INTERESTED_IN": RelationSpec(
        "campus", (("person", "club"),), ("fictional",)
    ),
    "FRIEND_OF": RelationSpec(
        "campus", (("person", "person"),), ("fictional",)
    ),
    "VOLUNTEERS_AT": RelationSpec(
        "campus", (("person", "event"),), ("fictional",)
    ),
    "MEETS_AT": RelationSpec("campus", (("club", "place"),), ("fictional",)),
    "MENTORS": RelationSpec(
        "campus", (("person", "person"),), ("fictional",)
    ),
}
RELATION_WHITELIST = tuple(sorted(RELATION_SPECS))
LAYER_SOURCE_TYPES = {
    "academic": frozenset({"paper", "openalex_metadata"}),
    "campus": frozenset({"fictional"}),
}


def _strict_fields(
    class_name: str, row: Mapping[str, object], fields: Iterable[str]
) -> None:
    expected = set(fields)
    actual = set(row)
    unknown = actual - expected
    missing = expected - actual
    if unknown:
        raise ValueError(f"{class_name} 包含未知字段: {sorted(unknown)}")
    if missing:
        raise ValueError(f"{class_name} 缺少字段: {sorted(missing)}")


def _iso_date(value: str, label: str) -> date:
    if not isinstance(value, str):
        raise TypeError(f"{label} 必须为 ISO 日期字符串")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{label} 不是有效 ISO 日期: {value}") from exc


def _validate_interval(start: str, end: str | None, label: str) -> None:
    start_date = _iso_date(start, f"{label}.start")
    if end is not None and _iso_date(end, f"{label}.end") <= start_date:
        raise ValueError(f"{label} 的结束日期必须晚于开始日期")


def _active(
    valid_from: str,
    valid_to: str | None,
    visible_from: str,
    visible_to: str | None,
    as_of: str,
) -> bool:
    at = _iso_date(as_of, "as_of")
    return (
        _iso_date(valid_from, "valid_from") <= at
        and (valid_to is None or at < _iso_date(valid_to, "valid_to"))
        and _iso_date(visible_from, "visible_from") <= at
        and (visible_to is None or at < _iso_date(visible_to, "visible_to"))
    )


@dataclass(frozen=True)
class SourceRecord:
    source_id: str
    layer: str
    source_type: str
    title: str
    url: str
    retrieved_at: str
    verification_note: str

    def __post_init__(self) -> None:
        if not self.source_id or not self.title or not self.url:
            raise ValueError("来源标识、标题和 URL 不能为空")
        if self.layer not in LAYERS:
            raise ValueError(f"未知来源图层: {self.layer}")
        if self.source_type not in SOURCE_TYPES:
            raise ValueError(f"未知来源类型: {self.source_type}")
        if self.source_type not in LAYER_SOURCE_TYPES[self.layer]:
            raise ValueError("来源类型与图层不匹配")
        _iso_date(self.retrieved_at, "retrieved_at")
        if self.source_type == "fictional":
            if not self.url.startswith("urn:campusecho:fictional:"):
                raise ValueError("虚构来源必须使用 urn:campusecho:fictional: 前缀")
        elif not self.url.startswith(("http://", "https://")):
            raise ValueError("真实来源 URL 必须为 http(s)")

    def to_dict(self) -> dict[str, object]:
        return {
            "source_id": self.source_id,
            "layer": self.layer,
            "source_type": self.source_type,
            "title": self.title,
            "url": self.url,
            "retrieved_at": self.retrieved_at,
            "verification_note": self.verification_note,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> SourceRecord:
        _strict_fields("SourceRecord", value, cls.__dataclass_fields__)
        return cls(**dict(value))


@dataclass(frozen=True)
class Entity:
    entity_id: str
    name: str
    entity_type: str
    layer: str
    family_id: str
    aliases: tuple[str, ...]
    source_ids: tuple[str, ...]
    valid_from: str
    valid_to: str | None
    visible_from: str
    visible_to: str | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "aliases", tuple(self.aliases))
        object.__setattr__(self, "source_ids", tuple(self.source_ids))
        if not self.entity_id or not self.name or not self.family_id:
            raise ValueError("实体标识、名称和 family_id 不能为空")
        if self.layer not in LAYERS:
            raise ValueError(f"未知图层: {self.layer}")
        if self.entity_type not in ENTITY_TYPES[self.layer]:
            raise ValueError(f"实体类型 {self.entity_type} 不属于图层 {self.layer}")
        if not self.source_ids:
            raise ValueError("实体必须至少有一个来源")
        if len(set(self.aliases)) != len(self.aliases) or self.name in self.aliases:
            raise ValueError("实体别名必须唯一且不能等于规范名称")
        if any(not alias.strip() for alias in self.aliases):
            raise ValueError("实体别名不能为空字符串")
        _validate_interval(self.valid_from, self.valid_to, "entity.valid")
        _validate_interval(self.visible_from, self.visible_to, "entity.visible")

    def to_dict(self) -> dict[str, object]:
        return {
            "entity_id": self.entity_id,
            "name": self.name,
            "entity_type": self.entity_type,
            "layer": self.layer,
            "family_id": self.family_id,
            "aliases": list(self.aliases),
            "source_ids": list(self.source_ids),
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "visible_from": self.visible_from,
            "visible_to": self.visible_to,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> Entity:
        _strict_fields("Entity", value, cls.__dataclass_fields__)
        row = dict(value)
        row["aliases"] = tuple(row["aliases"])
        row["source_ids"] = tuple(row["source_ids"])
        return cls(**row)


@dataclass(frozen=True)
class Triple:
    triple_id: str
    subject: str
    relation: str
    object: str
    layer: str
    family_id: str
    source_ids: tuple[str, ...]
    valid_from: str
    valid_to: str | None
    visible_from: str
    visible_to: str | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_ids", tuple(self.source_ids))
        if not self.triple_id or not self.subject or not self.object or not self.family_id:
            raise ValueError("三元组标识、端点和 family_id 不能为空")
        if self.layer not in LAYERS:
            raise ValueError(f"未知图层: {self.layer}")
        if self.relation not in RELATION_SPECS:
            raise ValueError(f"未知关系: {self.relation}")
        if RELATION_SPECS[self.relation].layer != self.layer:
            raise ValueError("关系与图层不匹配")
        if not self.source_ids:
            raise ValueError("三元组必须至少有一个来源")
        _validate_interval(self.valid_from, self.valid_to, "triple.valid")
        _validate_interval(self.visible_from, self.visible_to, "triple.visible")

    def to_dict(self) -> dict[str, object]:
        return {
            "triple_id": self.triple_id,
            "subject": self.subject,
            "relation": self.relation,
            "object": self.object,
            "layer": self.layer,
            "family_id": self.family_id,
            "source_ids": list(self.source_ids),
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "visible_from": self.visible_from,
            "visible_to": self.visible_to,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> Triple:
        _strict_fields("Triple", value, cls.__dataclass_fields__)
        row = dict(value)
        row["source_ids"] = tuple(row["source_ids"])
        return cls(**row)


@dataclass(frozen=True)
class QuestionPublic:
    question_id: str
    set_name: str
    split: str
    layer: str
    family_id: str
    kind: str
    prompt: str
    start_entity: str
    direction: str
    min_hops: int
    max_hops: int
    relation_whitelist: tuple[str, ...]
    as_of: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "relation_whitelist", tuple(self.relation_whitelist))
        if not self.question_id or not self.prompt or not self.family_id:
            raise ValueError("问题标识、题干和 family_id 不能为空")
        if self.set_name not in QUESTION_SETS or self.split not in SPLITS:
            raise ValueError("问题集合或划分未知")
        if self.layer not in LAYERS or self.kind not in QUESTION_KINDS:
            raise ValueError("问题图层或类型未知")
        if self.direction not in DIRECTIONS:
            raise ValueError("问题方向必须为 out/in")
        if self.min_hops not in (2, 3, 4) or self.max_hops not in (2, 3, 4):
            raise ValueError("问题跳数必须位于 2-4")
        if self.min_hops > self.max_hops:
            raise ValueError("问题最小跳数不能大于最大跳数")
        if not self.relation_whitelist:
            raise ValueError("问题必须声明关系白名单")
        if any(relation not in RELATION_WHITELIST for relation in self.relation_whitelist):
            raise ValueError("问题包含未知关系")
        if any(RELATION_SPECS[r].layer != self.layer for r in self.relation_whitelist):
            raise ValueError("问题关系白名单跨图层")
        _iso_date(self.as_of, "question.as_of")

    def to_dict(self) -> dict[str, object]:
        return {
            "question_id": self.question_id,
            "set_name": self.set_name,
            "split": self.split,
            "layer": self.layer,
            "family_id": self.family_id,
            "kind": self.kind,
            "prompt": self.prompt,
            "start_entity": self.start_entity,
            "direction": self.direction,
            "min_hops": self.min_hops,
            "max_hops": self.max_hops,
            "relation_whitelist": list(self.relation_whitelist),
            "as_of": self.as_of,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> QuestionPublic:
        _strict_fields("QuestionPublic", value, cls.__dataclass_fields__)
        row = dict(value)
        row["relation_whitelist"] = tuple(row["relation_whitelist"])
        return cls(**row)


@dataclass(frozen=True)
class AnswerLabel:
    question_id: str
    answers: tuple[str, ...]
    paths: tuple[tuple[str, ...], ...]
    hop_lengths: tuple[int, ...]
    solvable: bool

    def __post_init__(self) -> None:
        object.__setattr__(self, "answers", tuple(sorted(set(self.answers))))
        normalized_paths = tuple(sorted({tuple(path) for path in self.paths}))
        object.__setattr__(self, "paths", normalized_paths)
        object.__setattr__(self, "hop_lengths", tuple(sorted(set(self.hop_lengths))))
        if not self.question_id:
            raise ValueError("答案 question_id 不能为空")
        if self.solvable != bool(self.answers):
            raise ValueError("solvable 必须与答案集合是否为空一致")
        if self.solvable != bool(self.paths):
            raise ValueError("solvable 必须与有效路径是否为空一致")
        if (not self.solvable) and (self.paths or self.hop_lengths):
            raise ValueError("无解问题不得含路径或跳数")
        if any(len(path) not in (3, 4, 5) for path in self.paths):
            raise ValueError("每条路径必须包含起点、中间实体和终点，共 2-4 跳")
        derived_hops = tuple(sorted({len(path) - 1 for path in self.paths}))
        if self.hop_lengths != derived_hops:
            raise ValueError("hop_lengths 必须由有效路径推导")
        path_ends = tuple(sorted({path[-1] for path in self.paths}))
        if self.answers != path_ends:
            raise ValueError("answers 必须由有效路径终点推导")

    def to_dict(self) -> dict[str, object]:
        return {
            "question_id": self.question_id,
            "answers": list(self.answers),
            "paths": [list(path) for path in self.paths],
            "hop_lengths": list(self.hop_lengths),
            "solvable": self.solvable,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> AnswerLabel:
        _strict_fields("AnswerLabel", value, cls.__dataclass_fields__)
        row = dict(value)
        row["answers"] = tuple(row["answers"])
        row["paths"] = tuple(tuple(path) for path in row["paths"])
        row["hop_lengths"] = tuple(row["hop_lengths"])
        return cls(**row)


@dataclass(frozen=True)
class KnowledgeGraph:
    sources: tuple[SourceRecord, ...]
    entities: tuple[Entity, ...]
    triples: tuple[Triple, ...]
    _source_index: Mapping[str, SourceRecord] = field(
        init=False, repr=False, compare=False
    )
    _entity_index: Mapping[str, Entity] = field(
        init=False, repr=False, compare=False
    )
    _triple_index: Mapping[str, Triple] = field(
        init=False, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "entities", tuple(self.entities))
        object.__setattr__(self, "triples", tuple(self.triples))
        sources = _unique_index(self.sources, "source_id", "来源")
        entities = _unique_index(self.entities, "entity_id", "实体")
        triples = _unique_index(self.triples, "triple_id", "三元组")
        aliases: dict[str, str] = {}
        for entity in self.entities:
            if not set(entity.source_ids) <= set(sources):
                raise ValueError(f"实体 {entity.entity_id} 引用了未知来源")
            for alias in (entity.name, *entity.aliases):
                if alias in aliases and aliases[alias] != entity.entity_id:
                    raise ValueError(f"别名冲突: {alias}")
                aliases[alias] = entity.entity_id
        edge_keys: set[tuple[str, str, str, str]] = set()
        for triple in self.triples:
            if triple.subject not in entities or triple.object not in entities:
                raise ValueError(f"三元组 {triple.triple_id} 含未知实体")
            subject = entities[triple.subject]
            obj = entities[triple.object]
            if subject.layer != triple.layer or obj.layer != triple.layer:
                raise ValueError("三元组端点跨图层")
            if subject.family_id != triple.family_id or obj.family_id != triple.family_id:
                raise ValueError("三元组端点跨家族")
            if (subject.entity_type, obj.entity_type) not in RELATION_SPECS[
                triple.relation
            ].pairs:
                raise ValueError("三元组端点类型不符合关系白名单")
            if not set(triple.source_ids) <= set(sources):
                raise ValueError(f"三元组 {triple.triple_id} 引用了未知来源")
            triple_source_types = {
                sources[source_id].source_type for source_id in triple.source_ids
            }
            if any(sources[source_id].layer != triple.layer for source_id in triple.source_ids):
                raise ValueError("来源图层与三元组图层不匹配")
            if not triple_source_types <= set(
                RELATION_SPECS[triple.relation].source_types
            ):
                raise ValueError("来源类型不允许用于该关系")
            if not triple_source_types <= LAYER_SOURCE_TYPES[triple.layer]:
                raise ValueError("来源类型与图层不匹配")
            key = (triple.subject, triple.relation, triple.object, triple.family_id)
            if key in edge_keys:
                raise ValueError(f"重复边: {key}")
            edge_keys.add(key)
        object.__setattr__(self, "_source_index", MappingProxyType(sources))
        object.__setattr__(self, "_entity_index", MappingProxyType(entities))
        object.__setattr__(
            self,
            "_triple_index",
            MappingProxyType(triples),
        )

    @property
    def source_by_id(self) -> Mapping[str, SourceRecord]:
        return self._source_index

    @property
    def entity_by_id(self) -> Mapping[str, Entity]:
        return self._entity_index

    @property
    def triple_by_id(self) -> Mapping[str, Triple]:
        return self._triple_index

    def resolve_alias(self, value: str) -> str:
        matches = {
            entity.entity_id
            for entity in self.entities
            if value in (entity.name, *entity.aliases)
        }
        if len(matches) != 1:
            raise ValueError(f"别名无法唯一解析: {value}")
        return matches.pop()

    def active_triples(self, as_of: str) -> tuple[Triple, ...]:
        return tuple(
            triple
            for triple in self.triples
            if _active(
                triple.valid_from,
                triple.valid_to,
                triple.visible_from,
                triple.visible_to,
                as_of,
            )
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": SCHEMA_VERSION,
            "sources": [source.to_dict() for source in self.sources],
            "entities": [entity.to_dict() for entity in self.entities],
            "triples": [triple.to_dict() for triple in self.triples],
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> KnowledgeGraph:
        _strict_fields(
            "KnowledgeGraph",
            value,
            ("schema_version", "sources", "entities", "triples"),
        )
        if value["schema_version"] != SCHEMA_VERSION:
            raise ValueError("不支持的知识图谱 schema_version")
        return cls(
            tuple(SourceRecord.from_dict(row) for row in value["sources"]),
            tuple(Entity.from_dict(row) for row in value["entities"]),
            tuple(Triple.from_dict(row) for row in value["triples"]),
        )


def _unique_index(items: Iterable[object], attr: str, label: str) -> dict[str, object]:
    result: dict[str, object] = {}
    for item in items:
        key = getattr(item, attr)
        if key in result:
            raise ValueError(f"{label}标识重复: {key}")
        result[key] = item
    return result


@dataclass(frozen=True)
class KGData:
    graph: KnowledgeGraph
    questions: Mapping[str, tuple[QuestionPublic, ...]]
    labels: Mapping[str, tuple[AnswerLabel, ...]]
    manifest: Mapping[str, object]

    def __post_init__(self) -> None:
        questions = {name: tuple(rows) for name, rows in self.questions.items()}
        labels = {name: tuple(rows) for name, rows in self.labels.items()}
        if set(questions) != set(QUESTION_SETS) or set(labels) != set(QUESTION_SETS):
            raise ValueError("KGData 必须同时包含 core/robust 问题和标注")
        for set_name in QUESTION_SETS:
            public = _unique_index(questions[set_name], "question_id", "问题")
            private = _unique_index(labels[set_name], "question_id", "标注")
            if set(public) != set(private):
                raise ValueError(f"{set_name} 公开问题与私有标注 ID 不一致")
            for question in questions[set_name]:
                if question.set_name != set_name:
                    raise ValueError("问题 set_name 与所在集合不一致")
                if question.start_entity not in self.graph.entity_by_id:
                    raise ValueError("问题起点实体未知")
                if question.family_id != self.graph.entity_by_id[
                    question.start_entity
                ].family_id:
                    raise ValueError("问题起点跨家族")
        object.__setattr__(self, "questions", MappingProxyType(questions))
        object.__setattr__(self, "labels", MappingProxyType(labels))
        object.__setattr__(self, "manifest", MappingProxyType(dict(self.manifest)))

    def public_questions(self, set_name: str) -> tuple[QuestionPublic, ...]:
        """模型搜索入口：返回不含答案、路径或私有标注的冻结投影。"""
        if set_name not in QUESTION_SETS:
            raise ValueError(f"未知问题集合: {set_name}")
        return tuple(
            QuestionPublic(
                question.question_id,
                question.set_name,
                question.split,
                question.layer,
                question.family_id,
                question.kind,
                question.prompt,
                question.start_entity,
                question.direction,
                question.min_hops,
                question.max_hops,
                question.relation_whitelist,
                question.as_of,
            )
            for question in self.questions[set_name]
        )

    def private_labels(self, set_name: str) -> tuple[AnswerLabel, ...]:
        if set_name not in QUESTION_SETS:
            raise ValueError(f"未知问题集合: {set_name}")
        return self.labels[set_name]


def enumerate_answer(
    graph: KnowledgeGraph, question: QuestionPublic, max_paths: int = 10_000
) -> AnswerLabel:
    """按声明跳数、方向和可见时间穷举所有简单有效路径。"""
    if type(max_paths) is not int or max_paths < 1:
        raise ValueError("max_paths 必须为正整数")
    if question.start_entity not in graph.entity_by_id:
        raise ValueError("问题起点实体未知")
    start = graph.entity_by_id[question.start_entity]
    if start.layer != question.layer or start.family_id != question.family_id:
        raise ValueError("问题起点与图层或家族不匹配")
    allowed = set(question.relation_whitelist)
    adjacency: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for triple in graph.active_triples(question.as_of):
        if triple.layer != question.layer or triple.family_id != question.family_id:
            continue
        if triple.relation not in allowed:
            continue
        if question.direction == "out":
            adjacency[triple.subject].append((triple.object, triple.relation))
        else:
            adjacency[triple.object].append((triple.subject, triple.relation))
    paths: list[tuple[str, ...]] = []

    def walk(node: str, remaining: int, path: tuple[str, ...]) -> None:
        if len(paths) >= max_paths:
            raise ValueError("有效路径数超过 max_paths，拒绝截断穷举结果")
        if remaining == 0:
            paths.append(path)
            return
        for neighbor, _ in sorted(adjacency.get(node, ())):
            if neighbor in path:
                continue
            walk(neighbor, remaining - 1, (*path, neighbor))

    for hops in range(question.min_hops, question.max_hops + 1):
        walk(question.start_entity, hops, (question.start_entity,))
    return AnswerLabel(
        question.question_id,
        tuple(path[-1] for path in paths),
        tuple(paths),
        tuple(len(path) - 1 for path in paths),
        bool(paths),
    )


def verify_labels(
    graph: KnowledgeGraph,
    questions: Mapping[str, Iterable[QuestionPublic]],
    labels: Mapping[str, Iterable[AnswerLabel]],
) -> None:
    if set(questions) != set(QUESTION_SETS) or set(labels) != set(QUESTION_SETS):
        raise ValueError("核验必须同时包含 core/robust")
    for set_name in QUESTION_SETS:
        public = _unique_index(tuple(questions[set_name]), "question_id", "问题")
        private = _unique_index(tuple(labels[set_name]), "question_id", "标注")
        if set(public) != set(private):
            raise ValueError(f"{set_name} 公开问题与私有标注 ID 不一致")
        for question_id, question in public.items():
            expected = private[question_id]
            actual = enumerate_answer(graph, question)
            if actual != expected:
                raise ValueError(f"标注与穷举结果不一致: {question_id}")


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
        "utf-8"
    )


def _jsonl_bytes(rows: Iterable[Mapping[str, object]]) -> bytes:
    return "".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in rows
    ).encode("utf-8")


def write_kg_data(
    directory: str | Path,
    graph: KnowledgeGraph,
    questions: Mapping[str, tuple[QuestionPublic, ...]],
    labels: Mapping[str, tuple[AnswerLabel, ...]],
    manifest: Mapping[str, object],
) -> dict[str, object]:
    """写出图、公开问题、私有标注和内容指纹；先核验，再原子替换。"""
    verify_labels(graph, questions, labels)
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    payloads = {
        "graph.json": _json_bytes(graph.to_dict()),
        "questions_public.jsonl": _jsonl_bytes(
            question.to_dict()
            for set_name in QUESTION_SETS
            for question in questions[set_name]
        ),
        "answers_private.jsonl": _jsonl_bytes(
            label.to_dict()
            for set_name in QUESTION_SETS
            for label in labels[set_name]
        ),
    }
    result = dict(manifest)
    result["schema_version"] = SCHEMA_VERSION
    result["files"] = {
        name: {
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
        }
        for name, payload in payloads.items()
    }
    result["counts"] = {
        "sources": len(graph.sources),
        "entities": len(graph.entities),
        "triples": len(graph.triples),
        "questions": {
            set_name: len(questions[set_name]) for set_name in QUESTION_SETS
        },
        "labels": {set_name: len(labels[set_name]) for set_name in QUESTION_SETS},
    }
    payloads["manifest.json"] = _json_bytes(result)
    for name, payload in payloads.items():
        temporary = root / f".{name}.tmp"
        temporary.write_bytes(payload)
        temporary.replace(root / name)
    return result


def load_kg_data(directory: str | Path, *, verify: bool = True) -> KGData:
    root = Path(directory)
    graph = KnowledgeGraph.from_dict(
        json.loads((root / "graph.json").read_text(encoding="utf-8"))
    )
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    for name, entry in manifest["files"].items():
        payload = (root / name).read_bytes()
        if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
            raise ValueError(f"文件指纹不匹配: {name}")
    questions = {set_name: [] for set_name in QUESTION_SETS}
    for line in (root / "questions_public.jsonl").read_text(
        encoding="utf-8"
    ).splitlines():
        if line.strip():
            question = QuestionPublic.from_dict(json.loads(line))
            questions[question.set_name].append(question)
    labels = {set_name: [] for set_name in QUESTION_SETS}
    for line in (root / "answers_private.jsonl").read_text(
        encoding="utf-8"
    ).splitlines():
        if line.strip():
            label = AnswerLabel.from_dict(json.loads(line))
            set_name = next(
                question.set_name
                for rows in questions.values()
                for question in rows
                if question.question_id == label.question_id
            )
            labels[set_name].append(label)
    data = KGData(
        graph,
        {name: tuple(rows) for name, rows in questions.items()},
        {name: tuple(rows) for name, rows in labels.items()},
        manifest,
    )
    if verify:
        verify_labels(graph, data.questions, data.labels)
    return data


@dataclass(frozen=True)
class GenerationConfig:
    seed: int = 20261118
    campus_families: int = 16
    questions_per_family: int = 35
    robust_per_family: int = 7

    def __post_init__(self) -> None:
        if type(self.seed) is not int:
            raise TypeError("seed 必须为整数")
        if self.campus_families < 1:
            raise ValueError("campus_families 必须为正整数")
        if self.questions_per_family < 1 or self.robust_per_family < 1:
            raise ValueError("问题数量必须为正整数")


@dataclass(frozen=True)
class _AcademicPaper:
    key: str
    title: str
    title_zh: str
    arxiv_id: str
    openalex_id: str
    year: int
    authors: tuple[str, ...]
    model: str
    model_zh: str
    method: str
    method_zh: str
    dataset: str
    dataset_zh: str
    modality: str
    modality_zh: str
    topic: str
    topic_zh: str


_PAPERS = (
    _AcademicPaper(
        "attention",
        "Attention Is All You Need",
        "注意力就是你所需要的一切",
        "1706.03762",
        "W2626778328",
        2017,
        (
            "Ashish Vaswani",
            "Noam Shazeer",
            "Niki Parmar",
            "Jakob Uszkoreit",
            "Llion Jones",
            "Aidan N. Gomez",
            "Lukasz Kaiser",
            "Illia Polosukhin",
        ),
        "Transformer",
        "Transformer 模型",
        "Self-Attention",
        "自注意力机制",
        "WMT 2014",
        "WMT 2014 机器翻译数据集",
        "Text",
        "文本",
        "Natural Language Processing",
        "自然语言处理",
    ),
    _AcademicPaper(
        "bert",
        "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
        "BERT：面向语言理解的深度双向 Transformer 预训练",
        "1810.04805",
        "W2963341956",
        2019,
        ("Jacob Devlin", "Ming-Wei Chang", "Kenton Lee", "Kristina Toutanova"),
        "BERT",
        "BERT 模型",
        "Masked Language Modeling",
        "掩码语言建模",
        "GLUE",
        "GLUE 基准",
        "Text",
        "文本",
        "Natural Language Processing",
        "自然语言处理",
    ),
    _AcademicPaper(
        "rag",
        "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
        "面向知识密集型 NLP 任务的检索增强生成",
        "2005.11401",
        "W3098425262",
        2020,
        (
            "Patrick Lewis",
            "Ethan Perez",
            "Aleksandra Piktus",
            "Fabio Petroni",
            "Vladimir Karpukhin",
            "Naman Goyal",
            "Heinrich Küttler",
            "Mike Lewis",
            "Wen-tau Yih",
            "Tim Rocktäschel",
            "Sebastian Riedel",
            "Douwe Kiela",
        ),
        "RAG",
        "RAG 模型",
        "Dense Retrieval",
        "稠密检索",
        "Natural Questions",
        "Natural Questions 数据集",
        "Text",
        "文本",
        "Question Answering",
        "问答",
    ),
    _AcademicPaper(
        "vgg",
        "Very Deep Convolutional Networks for Large-Scale Image Recognition",
        "面向大规模图像识别的极深卷积网络",
        "1409.1556",
        "W1686810756",
        2014,
        ("Karen Simonyan", "Andrew Zisserman"),
        "VGG",
        "VGG 模型",
        "Small Convolution Filters",
        "小卷积核",
        "ImageNet",
        "ImageNet 数据集",
        "Image",
        "图像",
        "Computer Vision",
        "计算机视觉",
    ),
    _AcademicPaper(
        "resnet",
        "Deep Residual Learning for Image Recognition",
        "用于图像识别的深度残差学习",
        "1512.03385",
        "W2194775991",
        2016,
        ("Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"),
        "ResNet",
        "ResNet 模型",
        "Residual Learning",
        "残差学习",
        "ImageNet",
        "ImageNet 数据集",
        "Image",
        "图像",
        "Computer Vision",
        "计算机视觉",
    ),
    _AcademicPaper(
        "word2vec",
        "Efficient Estimation of Word Representations in Vector Space",
        "向量空间中词表示的有效估计",
        "1301.3781",
        "W1614298861",
        2013,
        ("Tomas Mikolov", "Kai Chen", "Greg Corrado", "Jeffrey Dean"),
        "Word2Vec",
        "Word2Vec 模型",
        "Continuous Word Vectors",
        "连续词向量",
        "Google News Corpus",
        "Google News 语料库",
        "Text",
        "文本",
        "Word Embeddings",
        "词嵌入",
    ),
)

_CAMPUS_NAMES = (
    ("星桥", "star_bridge"),
    ("青禾", "green_grain"),
    ("云帆", "cloud_sail"),
    ("拾光", "light_pick"),
    ("木棉", "kapok"),
    ("远山", "far_hill"),
    ("微澜", "ripple"),
    ("长庚", "evening_star"),
    ("春溪", "spring_creek"),
    ("南枝", "south_branch"),
    ("白露", "white_dew"),
    ("弦月", "crescent"),
    ("听风", "wind_listener"),
    ("映湖", "lake_reflection"),
    ("朝雾", "morning_mist"),
    ("归舟", "returning_boat"),
)


def _entity(
    entity_id: str,
    name: str,
    entity_type: str,
    layer: str,
    family_id: str,
    source_ids: tuple[str, ...],
    aliases: tuple[str, ...] = (),
    *,
    valid_from: str = "2010-01-01",
    valid_to: str | None = None,
    visible_from: str = "2010-01-01",
    visible_to: str | None = None,
) -> Entity:
    return Entity(
        entity_id,
        name,
        entity_type,
        layer,
        family_id,
        aliases,
        source_ids,
        valid_from,
        valid_to,
        visible_from,
        visible_to,
    )


def _triple(
    triple_id: str,
    subject: str,
    relation: str,
    obj: str,
    layer: str,
    family_id: str,
    source_ids: tuple[str, ...],
    *,
    valid_from: str = "2010-01-01",
    valid_to: str | None = None,
    visible_from: str = "2010-01-01",
    visible_to: str | None = None,
) -> Triple:
    return Triple(
        triple_id,
        subject,
        relation,
        obj,
        layer,
        family_id,
        source_ids,
        valid_from,
        valid_to,
        visible_from,
        visible_to,
    )


def _academic_graph() -> KnowledgeGraph:
    sources: list[SourceRecord] = []
    entities: list[Entity] = []
    triples: list[Triple] = []
    for paper in _PAPERS:
        family = f"academic:{paper.key}"
        paper_source = f"source:arxiv:{paper.arxiv_id}"
        oa_source = f"source:openalex:{paper.openalex_id}"
        sources.extend(
            (
                SourceRecord(
                    paper_source,
                    "academic",
                    "paper",
                    paper.title,
                    f"https://arxiv.org/abs/{paper.arxiv_id}",
                    "2026-11-18",
                    "arXiv API 元数据核对；论文原文链接可访问。",
                ),
                SourceRecord(
                    oa_source,
                    "academic",
                    "openalex_metadata",
                    paper.title,
                    f"https://openalex.org/{paper.openalex_id}",
                    "2026-11-18",
                    "OpenAlex 公开记录核对；仅用于书目关系，不替代论文原文。",
                ),
            )
        )
        ids = {
            "paper": f"paper:{paper.key}",
            "model": f"model:{paper.key}",
            "method": f"method:{paper.key}",
            "dataset": f"dataset:{paper.key}",
            "modality": f"modality:{paper.key}",
            "topic": f"topic:{paper.key}",
            "venue": f"venue:{paper.key}",
            "publisher": f"publisher:{paper.key}",
            "field": f"field:{paper.key}",
        }
        field_name = (
            "Computer Vision"
            if paper.topic == "Computer Vision"
            else "Word Embeddings"
            if paper.topic == "Word Embeddings"
            else "Natural Language Processing"
        )
        field_name_zh = (
            "计算机视觉"
            if field_name == "Computer Vision"
            else "词嵌入"
            if field_name == "Word Embeddings"
            else "自然语言处理"
        )
        entities.extend(
            (
                _entity(
                    ids["paper"],
                    paper.title,
                    "paper",
                    "academic",
                    family,
                    (paper_source, oa_source),
                    (paper.title_zh, f"arXiv:{paper.arxiv_id}"),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["model"],
                    paper.model,
                    "model",
                    "academic",
                    family,
                    (paper_source,),
                    (paper.model_zh,),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["method"],
                    paper.method,
                    "method",
                    "academic",
                    family,
                    (paper_source,),
                    (paper.method_zh,),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["dataset"],
                    f"{paper.key}:dataset:{paper.dataset}",
                    "dataset",
                    "academic",
                    family,
                    (paper_source,),
                    (f"{paper.key}:dataset:{paper.dataset_zh}",),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["modality"],
                    f"{paper.key}:{paper.modality}",
                    "modality",
                    "academic",
                    family,
                    (paper_source,),
                    (f"{paper.key}:{paper.modality_zh}",),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["topic"],
                    f"{paper.key}:topic:{paper.topic}",
                    "topic",
                    "academic",
                    family,
                    (oa_source,),
                    (f"{paper.key}:{paper.topic_zh}",),
                    valid_from=f"{paper.year}-01-01",
                ),
                _entity(
                    ids["venue"],
                    f"{paper.key}:venue:arXiv",
                    "venue",
                    "academic",
                    family,
                    (paper_source, oa_source),
                    (f"{paper.key}:venue:arXiv 预印本平台",),
                    valid_from="1991-08-01",
                ),
                _entity(
                    ids["publisher"],
                    f"{paper.key}:publisher:Cornell University",
                    "publisher",
                    "academic",
                    family,
                    (oa_source,),
                    (f"{paper.key}:publisher:康奈尔大学",),
                    valid_from="1991-08-01",
                ),
                _entity(
                    ids["field"],
                    f"{paper.key}:{field_name}",
                    "field",
                    "academic",
                    family,
                    (oa_source,),
                    (f"{paper.key}:field:{field_name_zh}",),
                    valid_from=f"{paper.year}-01-01",
                ),
            )
        )
        for index, author in enumerate(paper.authors):
            person_id = f"person:{paper.key}:{index}"
            entities.append(
                _entity(
                    person_id,
                    author,
                    "person",
                    "academic",
                    family,
                    (paper_source,),
                    valid_from=f"{paper.year}-01-01",
                )
            )
            triples.append(
                _triple(
                    f"{family}:award:{index}",
                    person_id,
                    "AUTHORED_BY",
                    ids["paper"],
                    "academic",
                    family,
                    (paper_source,),
                    valid_from=f"{paper.year}-01-01",
                )
            )
        relations = (
            ("INTRODUCES", ids["paper"], ids["model"]),
            ("USES", ids["model"], ids["method"]),
            ("EVALUATED_ON", ids["paper"], ids["dataset"]),
            ("HAS_MODALITY", ids["dataset"], ids["modality"]),
            ("PUBLISHED_AT", ids["paper"], ids["venue"]),
            ("PUBLISHED_BY", ids["venue"], ids["publisher"]),
            ("ABOUT", ids["paper"], ids["topic"]),
            ("PART_OF", ids["topic"], ids["field"]),
        )
        for index, (relation, subject, obj) in enumerate(relations):
            triples.append(
                _triple(
                    f"{family}:r{index}",
                    subject,
                    relation,
                    obj,
                    "academic",
                    family,
                    (paper_source, oa_source),
                    valid_from=f"{paper.year}-01-01",
                )
            )
    return KnowledgeGraph(tuple(sources), tuple(entities), tuple(triples))


def _campus_family(
    index: int, label: str, slug: str, source_id: str
) -> tuple[list[Entity], list[Triple]]:
    family = f"campus:{slug}"
    entities: list[Entity] = []
    triples: list[Triple] = []
    clubs = ("摄影社", "辩论队", "天文社", "志愿服务队")
    zones = ("东区", "西区")
    places = ("湖畔广场", "学生中心", "旧礼堂", "北操场")
    events = ("迎新夜", "读书会", "公益跑", "社团开放日")
    for club_index, name in enumerate(clubs):
        entities.append(
            _entity(
                f"club:{index:02d}:{club_index}",
                f"{label}{name}",
                "club",
                "campus",
                family,
                (source_id,),
                (f"{slug}-{name}",),
            )
        )
    for zone_index, name in enumerate(zones):
        entities.append(
            _entity(
                f"zone:{index:02d}:{zone_index}",
                f"{label}{name}",
                "zone",
                "campus",
                family,
                (source_id,),
            )
        )
    for place_index, name in enumerate(places):
        entities.append(
            _entity(
                f"place:{index:02d}:{place_index}",
                f"{label}{name}",
                "place",
                "campus",
                family,
                (source_id,),
                (f"{slug}-{name}",),
            )
        )
        triples.append(
            _triple(
                f"{family}:place-zone:{place_index}",
                f"place:{index:02d}:{place_index}",
                "LOCATED_IN",
                f"zone:{index:02d}:{place_index % 2}",
                "campus",
                family,
                (source_id,),
            )
        )
    for event_index, name in enumerate(events):
        event_id = f"event:{index:02d}:{event_index}"
        place_id = f"place:{index:02d}:{event_index}"
        club_id = f"club:{index:02d}:{event_index}"
        entities.append(
            _entity(
                event_id,
                f"{label}{name}",
                "event",
                "campus",
                family,
                (source_id,),
                (f"{slug}-{name}",),
                valid_from="2026-09-01",
                valid_to="2027-01-01",
                visible_from="2026-09-01",
            )
        )
        triples.extend(
            (
                _triple(
                    f"{family}:event-club:{event_index}",
                    club_id,
                    "ORGANIZES",
                    event_id,
                    "campus",
                    family,
                    (source_id,),
                    valid_from="2026-09-01",
                    valid_to="2027-01-01",
                    visible_from="2026-09-01",
                ),
                _triple(
                    f"{family}:event-place:{event_index}",
                    event_id,
                    "HELD_AT",
                    place_id,
                    "campus",
                    family,
                    (source_id,),
                    valid_from="2026-09-01",
                    valid_to="2027-01-01",
                    visible_from="2026-09-01",
                ),
                _triple(
                    f"{family}:club-place:{event_index}",
                    club_id,
                    "MEETS_AT",
                    place_id,
                    "campus",
                    family,
                    (source_id,),
                    visible_from="2026-09-01",
                ),
            )
        )
    for person_index in range(12):
        person_id = f"person:{index:02d}:{person_index:02d}"
        entities.append(
            _entity(
                person_id,
                f"{label}同学{person_index + 1:02d}",
                "person",
                "campus",
                family,
                (source_id,),
                (f"{slug}-student-{person_index + 1:02d}",),
            )
        )
        club_index = person_index % 4
        triples.extend(
            (
                _triple(
                    f"{family}:member:{person_index}",
                    person_id,
                    "MEMBER_OF",
                    f"club:{index:02d}:{club_index}",
                    "campus",
                    family,
                    (source_id,),
                ),
                _triple(
                    f"{family}:interest:{person_index}",
                    person_id,
                    "INTERESTED_IN",
                    f"club:{index:02d}:{(club_index + 1) % 4}",
                    "campus",
                    family,
                    (source_id,),
                ),
                _triple(
                    f"{family}:friend:{person_index}",
                    person_id,
                    "FRIEND_OF",
                    f"person:{index:02d}:{(person_index + 1) % 12:02d}",
                    "campus",
                    family,
                    (source_id,),
                ),
                _triple(
                    f"{family}:attend:{person_index}",
                    person_id,
                    "ATTENDS",
                    f"event:{index:02d}:{person_index % 4}",
                    "campus",
                    family,
                    (source_id,),
                    valid_from="2026-09-01",
                    valid_to="2027-01-01",
                    visible_from="2026-09-01",
                ),
            )
        )
        if person_index < 4:
            triples.append(
                _triple(
                    f"{family}:volunteer:{person_index}",
                    person_id,
                    "VOLUNTEERS_AT",
                    f"event:{index:02d}:{(person_index + 2) % 4}",
                    "campus",
                    family,
                    (source_id,),
                    valid_from="2026-09-01",
                    valid_to="2027-01-01",
                    visible_from="2026-09-01",
                )
            )
        if person_index < 2:
            triples.append(
                _triple(
                    f"{family}:advise:{person_index}",
                    person_id,
                    "ADVISES",
                    f"club:{index:02d}:{person_index}",
                    "campus",
                    family,
                    (source_id,),
                )
            )
        if person_index >= 10:
            triples.append(
                _triple(
                    f"{family}:mentor:{person_index}",
                    person_id,
                    "MENTORS",
                    f"person:{index:02d}:{person_index - 10:02d}",
                    "campus",
                    family,
                    (source_id,),
                )
            )
    return entities, triples


def _campus_graph(families: int) -> KnowledgeGraph:
    if families > len(_CAMPUS_NAMES):
        raise ValueError(f"最多支持 {len(_CAMPUS_NAMES)} 个校园家族")
    sources = tuple(
        SourceRecord(
            f"source:fictional:{index:02d}",
            "campus",
            "fictional",
            f"虚构校园家族 {label}",
            f"urn:campusecho:fictional:{slug}",
            "2026-11-18",
            "完全虚构，仅用于受控图谱评测；不声称对应任何真实人物或组织。",
        )
        for index, (label, slug) in enumerate(_CAMPUS_NAMES[:families])
    )
    entities: list[Entity] = []
    triples: list[Triple] = []
    for index, (label, slug) in enumerate(_CAMPUS_NAMES[:families]):
        family_entities, family_triples = _campus_family(
            index, label, slug, f"source:fictional:{index:02d}"
        )
        entities.extend(family_entities)
        triples.extend(family_triples)
    return KnowledgeGraph(sources, tuple(entities), tuple(triples))


def _merge_graphs(*graphs: KnowledgeGraph) -> KnowledgeGraph:
    return KnowledgeGraph(
        tuple(source for graph in graphs for source in graph.sources),
        tuple(entity for graph in graphs for entity in graph.entities),
        tuple(triple for graph in graphs for triple in graph.triples),
    )


def _family_split(index: int, total: int, *, offset: int = 0) -> str:
    if total == 3:
        return SPLITS[index]
    train_count = max(1, round(total * 0.6))
    val_count = max(1, round(total * 0.2))
    relative = (index - offset) % total
    if relative < train_count:
        return "train"
    if relative < train_count + val_count:
        return "val"
    return "test"


def _split_offset(total: int) -> int:
    return 3 if total == len(_CAMPUS_NAMES) else 0


def _academic_split(family_id: str) -> str:
    key = family_id.removeprefix("academic:")
    if key in {"rag"}:
        return "val"
    if key in {"bert", "resnet"}:
        return "test"
    return "train"


def _prompt(
    layer: str, start: Entity, relation_whitelist: tuple[str, ...], hops: int
) -> str:
    relation_text = "、".join(relation_whitelist)
    if layer == "academic":
        return (
            f"从“{start.name}”出发，沿 {relation_text} 关系走 {hops} 跳，"
            "列出所有可达实体。"
        )
    return (
        f"在虚构校园中，从“{start.name}”出发，沿 {relation_text} 关系走 {hops} 跳，"
        "列出所有可达实体。"
    )


def _candidate_questions(
    graph: KnowledgeGraph, set_name: str, per_family: int
) -> list[QuestionPublic]:
    questions: list[QuestionPublic] = []
    by_family: dict[str, list[Entity]] = defaultdict(list)
    for entity in graph.entities:
        by_family[entity.family_id].append(entity)
    split_index = {
        f"campus:{slug}": index
        for index, (_, slug) in enumerate(_CAMPUS_NAMES)
    }
    campus_total = sum(family.startswith("campus:") for family in by_family)
    for family_id in sorted(by_family):
        entities = sorted(by_family[family_id], key=lambda item: item.entity_id)
        if family_id.startswith("academic:"):
            layer = "academic"
            split = _academic_split(family_id)
            as_of = "2026-11-18"
            allowed = (
                "INTRODUCES",
                "USES",
                "EVALUATED_ON",
                "HAS_MODALITY",
                "PUBLISHED_AT",
                "PUBLISHED_BY",
                "ABOUT",
                "PART_OF",
                "AUTHORED_BY",
            )
        else:
            layer = "campus"
            split = _family_split(
                split_index[family_id],
                campus_total,
                offset=_split_offset(campus_total),
            )
            as_of = "2026-11-18"
            allowed = (
                "MEMBER_OF",
                "ADVISES",
                "ORGANIZES",
                "HELD_AT",
                "LOCATED_IN",
                "ATTENDS",
                "INTERESTED_IN",
                "FRIEND_OF",
                "VOLUNTEERS_AT",
                "MEETS_AT",
                "MENTORS",
            )
        starts = [
            entity
            for entity in entities
            if any(
                triple.subject == entity.entity_id
                for triple in graph.triples
                if triple.family_id == family_id
            )
        ]
        wanted = per_family if layer == "campus" else max(2, per_family // 2)
        for offset in range(wanted):
            start = starts[offset % len(starts)]
            hops = 2 + (offset % 3)
            direction = "in" if offset % 7 == 0 else "out"
            kind = "core" if set_name == "core" else "generalized"
            question_id = (
                f"{set_name}:{family_id.replace(':', '-')}:{offset:03d}"
            )
            questions.append(
                QuestionPublic(
                    question_id,
                    set_name,
                    split,
                    layer,
                    family_id,
                    kind,
                    _prompt(layer, start, allowed, hops),
                    start.entity_id,
                    direction,
                    hops,
                    hops,
                    allowed,
                    as_of,
                )
            )
    return questions


def _mutate_question(
    graph: KnowledgeGraph,
    question: QuestionPublic,
    kind: str,
    *,
    seed: int,
    family_index: int,
) -> QuestionPublic:
    if kind == "alias":
        start = graph.entity_by_id[question.start_entity]
        if not start.aliases:
            raise ValueError("别名变体需要起点具有别名")
        return replace(
            question,
            prompt=question.prompt.replace(start.name, start.aliases[0], 1),
            kind=kind,
        )
    if kind == "paraphrase":
        return replace(
            question,
            prompt="请沿给定关系白名单逐跳追踪，并返回终点实体集合：" + question.prompt,
            kind=kind,
        )
    if kind == "reverse":
        return replace(question, direction="in", kind=kind)
    if kind == "relation_chain":
        relations = tuple(reversed(question.relation_whitelist))
        return replace(question, relation_whitelist=relations, kind=kind)
    if kind == "visibility":
        return replace(question, as_of="2026-08-15", kind=kind)
    if kind == "unsolvable":
        other = next(
            entity
            for entity in graph.entities
            if entity.layer == question.layer
            and entity.family_id != question.family_id
        )
        return replace(
            question,
            start_entity=other.entity_id,
            family_id=other.family_id,
            kind=kind,
        )
    if kind == "multipath":
        return replace(
            question,
            min_hops=2,
            max_hops=4,
            kind=kind,
        )
    raise ValueError(f"未知稳健问题类型: {kind}")


def _robust_questions(
    graph: KnowledgeGraph,
    core: tuple[QuestionPublic, ...],
    per_family: int,
) -> list[QuestionPublic]:
    kinds = (
        "alias",
        "paraphrase",
        "unsolvable",
        "multipath",
        "visibility",
        "reverse",
        "relation_chain",
    )
    by_family: dict[str, list[QuestionPublic]] = defaultdict(list)
    for question in core:
        if question.layer == "campus":
            by_family[question.family_id].append(question)
    robust: list[QuestionPublic] = []
    campus_families = sorted(by_family)
    for family_id in campus_families:
        candidates = by_family[family_id]
        for offset in range(per_family):
            base = candidates[offset % len(candidates)]
            kind = kinds[offset % len(kinds)]
            try:
                question = _mutate_question(
                    graph,
                    base,
                    kind,
                    seed=20261118,
                    family_index=offset,
                )
            except (ValueError, StopIteration):
                question = replace(base, kind=kind)
            robust.append(
                replace(
                    question,
                    question_id=f"robust:{family_id.replace(':', '-')}:{offset:03d}",
                    set_name="robust",
                )
            )
    return robust


def generate_kg_data(config: GenerationConfig | None = None) -> KGData:
    config = config or GenerationConfig()
    graph = _merge_graphs(
        _academic_graph(), _campus_graph(config.campus_families)
    )
    core = tuple(
        _candidate_questions(graph, "core", config.questions_per_family)
    )
    robust = tuple(
        _robust_questions(graph, core, config.robust_per_family)
    )
    questions = {"core": core, "robust": robust}
    labels = {
        set_name: tuple(enumerate_answer(graph, question) for question in rows)
        for set_name, rows in questions.items()
    }
    manifest = _build_manifest(graph, questions, labels, config)
    return KGData(graph, questions, labels, manifest)


def _build_manifest(
    graph: KnowledgeGraph,
    questions: Mapping[str, tuple[QuestionPublic, ...]],
    labels: Mapping[str, tuple[AnswerLabel, ...]],
    config: GenerationConfig,
) -> dict[str, object]:
    family_splits: dict[str, str] = {}
    family_sizes = {
        family: sum(entity.family_id == family for entity in graph.entities)
        for family in sorted({entity.family_id for entity in graph.entities})
    }
    campus_total = sum(family.startswith("campus:") for family in family_sizes)
    campus_offset = _split_offset(campus_total)
    for family in sorted({entity.family_id for entity in graph.entities}):
        family_splits[family] = (
            _academic_split(family)
            if family.startswith("academic:")
            else _family_split(
                next(
                    index
                    for index, (_, slug) in enumerate(_CAMPUS_NAMES)
                    if family == f"campus:{slug}"
                ),
                campus_total,
                offset=campus_offset,
            )
        )
    for question in questions["core"]:
        previous = family_splits.setdefault(question.family_id, question.split)
        if previous != question.split:
            raise ValueError(f"家族跨分割: {question.family_id}")
    split_families = {
        split: [f for f, assigned in family_splits.items() if assigned == split]
        for split in SPLITS
    }
    split_entities = {
        split: sum(family_sizes[f] for f in families)
        for split, families in split_families.items()
    }
    total = sum(split_entities.values())
    ratios = {
        split: round(split_entities[split] / total, 4) if total else 0.0
        for split in SPLITS
    }
    return {
        "generator": "campusecho_kg_v1",
        "seed": config.seed,
        "retrieved_at": "2026-11-18",
        "academic_sources_verified": True,
        "academic_verification": (
            "6 篇论文的 arXiv API 元数据与 OpenAlex 公开记录已核对；"
            "关系按论文摘要与公开书目字段人工映射。"
        ),
        "campus_layer": "fictional; no real person, club, event or place is asserted",
        "split_policy": "family_id; all entities, triples and questions stay together",
        "family_splits": family_splits,
        "split_ratios": ratios,
        "split_entities": split_entities,
        "question_hops": "2-4; labels store every simple valid path",
        "answer_projection": (
            "questions_public.jsonl contains no answers or paths; "
            "answers_private.jsonl is evaluator-only"
        ),
        "relation_whitelist": list(RELATION_WHITELIST),
        "source_types": list(SOURCE_TYPES),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成 CampusEcho 可审计 KG 数据")
    parser.add_argument("--output", default="data/kg")
    parser.add_argument("--seed", type=int, default=20261118)
    parser.add_argument("--campus-families", type=int, default=16)
    parser.add_argument("--questions-per-family", type=int, default=35)
    parser.add_argument("--robust-per-family", type=int, default=7)
    args = parser.parse_args(argv)
    config = GenerationConfig(
        args.seed,
        args.campus_families,
        args.questions_per_family,
        args.robust_per_family,
    )
    data = generate_kg_data(config)
    manifest = write_kg_data(
        args.output, data.graph, data.questions, data.labels, data.manifest
    )
    print(json.dumps(manifest["counts"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
