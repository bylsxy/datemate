"""独立校园轨迹模拟及按 episode 划分的数据集。

生成器只使用公开地图、日程、行走和消息机制，不调用任何推理模型。
truth 只存在于 DatasetCase/JSONL 的评测侧；inference_inputs 显式剥离它。
时间单位为分钟，日程使用一天内的绝对分钟数。
"""

from __future__ import annotations

import hashlib
import heapq
import json
import random
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from types import MappingProxyType

from .evidence import Evidence
from .world import EDGES, FRAME

SOURCES = ("roommate", "clubmate", "camera", "direct")
TIME_OF_DAY = ("morning", "noon", "afternoon", "evening")
WEATHER = ("clear", "rain")
SPLITS = ("train", "val", "test")
DATA_SCHEMA_VERSION = 1
_PLACES = tuple(sorted(FRAME - {"transit"}))
_SOURCE_ACCURACY = {"roommate": 0.78, "clubmate": 0.83, "camera": 0.91, "direct": 0.94}
_MISSING_RATE = {"roommate": 0.12, "clubmate": 0.10, "camera": 0.07, "direct": 0.15}
_DELAYS = {"roommate": (3, 18), "clubmate": (2, 12), "camera": (1, 5), "direct": (0, 7)}


def time_of_day(now: float) -> str:
    """将一天内分钟映射到预先约定的四个公开日程段。"""
    minute = now % 1440
    if minute < 690:
        return "morning"
    if minute < 840:
        return "noon"
    if minute < 1080:
        return "afternoon"
    return "evening"


@dataclass(frozen=True)
class DatasetCase:
    case_id: str
    episode_id: str
    split: str
    seed: int
    now: float
    context: Mapping[str, str]
    evidence: tuple[Evidence, ...]
    truth: str
    variant_id: int = 0
    regime: str = "iid"

    def __post_init__(self) -> None:
        if self.split not in SPLITS:
            raise ValueError("split 必须为 train/val/test")
        if not self.case_id or not self.episode_id:
            raise ValueError("case_id 与 episode_id 不能为空")
        if self.truth not in FRAME:
            raise ValueError("truth 超出校园位置框架")
        if set(self.context) != {"time_of_day", "weather"}:
            raise ValueError("context 必须且只能包含 time_of_day/weather")
        if self.context["time_of_day"] not in TIME_OF_DAY or self.context["weather"] not in WEATHER:
            raise ValueError("context 状态未知")
        if any(not isinstance(record, Evidence) for record in self.evidence):
            raise TypeError("evidence 必须由 Evidence 组成")
        object.__setattr__(self, "context", MappingProxyType(dict(self.context)))
        object.__setattr__(self, "evidence", tuple(self.evidence))

    def inference_inputs(self) -> tuple[tuple[Evidence, ...], float, dict[str, str]]:
        """唯一的模型输入投影，不暴露 seed、episode_id、regime 或 truth。"""
        return self.evidence, self.now, dict(self.context)

    def to_dict(self) -> dict[str, object]:
        records = []
        for item in self.evidence:
            row = asdict(item)
            row["support"] = None if item.support is None else sorted(item.support)
            records.append(row)
        return {
            "schema_version": DATA_SCHEMA_VERSION,
            "case_id": self.case_id,
            "episode_id": self.episode_id,
            "split": self.split,
            "seed": self.seed,
            "now": self.now,
            "context": dict(self.context),
            "evidence": records,
            "truth": self.truth,
            "variant_id": self.variant_id,
            "regime": self.regime,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> DatasetCase:
        row = dict(value)
        if row.pop("schema_version", None) != DATA_SCHEMA_VERSION:
            raise ValueError("不支持的数据集 schema_version")
        row["evidence"] = tuple(Evidence(**item) for item in row["evidence"])
        return cls(**row)


def _derived_seed(seed: int, *parts: object) -> int:
    key = ":".join(map(str, (seed, *parts)))
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")


def _adjacency() -> dict[str, tuple[tuple[str, int], ...]]:
    graph: dict[str, list[tuple[str, int]]] = {place: [] for place in _PLACES}
    for left, right, minutes in EDGES:
        graph[left].append((right, minutes))
        graph[right].append((left, minutes))
    return {place: tuple(sorted(edges)) for place, edges in graph.items()}


_GRAPH = _adjacency()


def _path(start: str, end: str) -> tuple[tuple[str, int], ...]:
    queue = [(0, start, ())]
    seen: set[str] = set()
    while queue:
        cost, place, route = heapq.heappop(queue)
        if place in seen:
            continue
        seen.add(place)
        if place == end:
            return route
        for neighbor, minutes in _GRAPH[place]:
            if neighbor not in seen:
                heapq.heappush(queue, (cost + minutes, neighbor, (*route, (neighbor, minutes))))
    raise ValueError("校园地图不连通")


def _destination(rng: random.Random, minute: int, weather: str, current: str | None) -> str:
    weights = {
        "morning": {"teaching": 7, "library": 3, "canteen": 1},
        "noon": {"canteen": 8, "walkway": 2, "library": 1},
        "afternoon": {"library": 4, "club": 5, "venue": 3, "teaching": 2},
        "evening": {"venue": 5, "club": 4, "canteen": 3, "library": 2},
    }[time_of_day(minute)]
    values = {place: weights.get(place, 0.4) for place in _PLACES}
    if weather == "rain":
        values["walkway"] *= 3
        values["venue"] *= 0.65
    if current is not None:
        values[current] = 0
    return rng.choices(_PLACES, weights=[values[place] for place in _PLACES], k=1)[0]


def _simulate_path(
    rng: random.Random, start: int, stop: int, weather: str, regime: str
) -> dict[int, str]:
    """真实轨迹来自有停留时间的地图路径；边上分钟显式记为 transit。"""
    minute = start
    location = _destination(rng, start, weather, None)
    truth: dict[int, str] = {}
    while minute <= stop:
        dwell = rng.randint(4, 11) if regime == "mobility_shift" else rng.randint(12, 30)
        for tick in range(minute, min(stop + 1, minute + dwell)):
            truth[tick] = location
        minute += dwell
        destination = _destination(rng, minute, weather, location)
        for neighbor, duration in _path(location, destination):
            travel = duration + (2 if weather == "rain" else 0)
            for tick in range(minute, min(stop + 1, minute + travel)):
                truth[tick] = "transit"
            minute += travel
            location = neighbor
    return truth


def _reports(
    rng: random.Random,
    episode_id: str,
    variant: int,
    truth: Mapping[int, str],
    weather: str,
    regime: str,
) -> tuple[Evidence, ...]:
    records = []
    first, last = min(truth), max(truth)
    for source in SOURCES:
        minute = first + rng.randint(0, 5)
        index = 0
        while minute <= last:
            actual = truth[minute]
            accuracy = _SOURCE_ACCURACY[source]
            if weather == "rain" and source == "camera":
                accuracy -= 0.13
            if regime == "reliability_shift" and source in ("roommate", "camera"):
                accuracy -= 0.27
            if rng.random() < _MISSING_RATE[source]:
                support = None
            else:
                reported = actual
                if rng.random() > accuracy:
                    # 噪声优先混淆旧位置或地图邻居，非推理 CPD 的反向采样。
                    previous = truth[max(first, minute - rng.randint(3, 14))]
                    alternatives = [place for place in sorted(FRAME) if place != actual]
                    neighbors = [place for place, _ in _GRAPH.get(actual, ())]
                    candidates = ([previous] if previous != actual else []) + neighbors
                    reported = rng.choice(candidates or alternatives)
                support = frozenset({reported})
                if source != "direct" and rng.random() < 0.12:
                    neighbors = [place for place, _ in _GRAPH.get(reported, ())]
                    extra = rng.choice(neighbors or [p for p in _PLACES if p != reported])
                    support = support | {extra}
            low, high = _DELAYS[source]
            delay = rng.randint(low, high) + (
                rng.randint(4, 13) if regime == "mobility_shift" else 0
            )
            origin = f"{episode_id}:v{variant}:{source}:{index}"
            item = Evidence(
                origin,
                source,
                origin,
                support,
                _SOURCE_ACCURACY[source],
                minute,
                minute + delay,
            )
            records.append(item)
            # 同源转发可跨快照反复出现，保持 origin；时间保证不会抢在原文前可见。
            if rng.random() < 0.35:
                for copy in range(rng.randint(1, 3)):
                    records.append(
                        Evidence(
                            f"{origin}:copy{copy}",
                            f"relay-{copy}",
                            origin,
                            support,
                            item.reliability,
                            minute,
                            item.received_at + copy + 1,
                        )
                    )
            minute += rng.randint(6, 14)
            index += 1
    return tuple(sorted(records, key=lambda item: (item.received_at, item.evidence_id)))


def generate_dataset(
    *,
    seed: int = 20261103,
    train_episodes: int = 3000,
    val_episodes: int = 1000,
    test_episodes: int = 1000,
    snapshots: int = 3,
    noise_variants: int = 1,
) -> dict[str, tuple[DatasetCase, ...]]:
    """默认生成 5000 条独立轨迹、15000 个快照；小规模参数供单元测试。"""
    counts = dict(zip(SPLITS, (train_episodes, val_episodes, test_episodes)))
    if type(seed) is not int:
        raise TypeError("seed 必须为整数")
    if any(type(count) is not int or count < 0 for count in counts.values()):
        raise ValueError("轨迹数量必须为非负整数")
    if type(snapshots) is not int or snapshots < 1:
        raise ValueError("snapshots 必须为正整数")
    if type(noise_variants) is not int or noise_variants < 1:
        raise ValueError("noise_variants 必须为正整数")
    dataset: dict[str, tuple[DatasetCase, ...]] = {}
    for split, count in counts.items():
        cases = []
        for index in range(count):
            episode_id = f"{seed}:{split}:{index:06d}"
            path_rng = random.Random(_derived_seed(seed, split, index, "path"))
            weather = path_rng.choices(WEATHER, weights=(0.6, 0.4), k=1)[0]
            anchor = path_rng.choice((540, 720, 900, 1120)) + path_rng.randint(-30, 30)
            regime = (
                ("iid", "mobility_shift", "reliability_shift")[index % 3]
                if split == "test"
                else "iid"
            )
            times = tuple(anchor + 20 * snapshot for snapshot in range(snapshots))
            truth = _simulate_path(path_rng, anchor - 45, times[-1], weather, regime)
            for variant in range(noise_variants):
                noise_rng = random.Random(_derived_seed(seed, split, index, "noise", variant))
                reports = _reports(noise_rng, episode_id, variant, truth, weather, regime)
                for snapshot, now in enumerate(times):
                    cases.append(
                        DatasetCase(
                            f"{episode_id}:v{variant}:t{snapshot}",
                            episode_id,
                            split,
                            seed,
                            now,
                            {"time_of_day": time_of_day(now), "weather": weather},
                            tuple(item for item in reports if item.received_at <= now),
                            truth[now],
                            variant,
                            regime,
                        )
                    )
        dataset[split] = tuple(cases)
    return dataset


def write_dataset(
    directory: str | Path, dataset: Mapping[str, tuple[DatasetCase, ...]]
) -> dict[str, object]:
    """写出评测侧 JSONL 与可审计 manifest；跨分割 episode 重叠立即拒绝。"""
    if set(dataset) != set(SPLITS):
        raise ValueError("数据集必须同时具有 train/val/test")
    episodes: dict[str, str] = {}
    ids: set[str] = set()
    for split, cases in dataset.items():
        for case in cases:
            if case.split != split:
                raise ValueError("case.split 与目标分割不一致")
            if case.episode_id in episodes and episodes[case.episode_id] != split:
                raise ValueError("episode 跨分割泄漏")
            if case.case_id in ids:
                raise ValueError("case_id 重复")
            episodes[case.episode_id] = split
            ids.add(case.case_id)
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, object] = {
        "schema_version": DATA_SCHEMA_VERSION,
        "generator": "campus_schedule_walk_delay_copy_v1",
        "inference_model_used_by_generator": False,
        "time_unit": "minute",
        "sources": list(SOURCES),
        "frame": sorted(FRAME),
        "seeds": sorted({case.seed for cases in dataset.values() for case in cases}),
        "truth_access": "evaluator_only; use DatasetCase.inference_inputs for models",
        "split_unit": "episode_id; all snapshots and noise variants stay together",
        "test_frozen": True,
        "generator_assumptions": {
            "source_accuracy_design_values": dict(_SOURCE_ACCURACY),
            "missing_probability": dict(_MISSING_RATE),
            "message_delay_minutes": {source: list(value) for source, value in _DELAYS.items()},
            "direct_role": "self-reported message with noise, delay and missing replies; not omniscient sighting",
            "ordinary_dwell_minutes": [12, 30],
            "mobility_shift_dwell_minutes": [4, 11],
            "mobility_shift_extra_delay_minutes": [4, 13],
            "reliability_shift": "roommate and camera accuracy minus .27; declared reliability unchanged",
            "rain_shift": "camera accuracy minus .13; map edges take two extra minutes",
            "inference_parameters_shared": False,
        },
        "splits": {},
        "episodes": [{"episode_id": key, "split": episodes[key]} for key in sorted(episodes)],
    }
    for split in SPLITS:
        cases = dataset[split]
        payload = "".join(
            json.dumps(case.to_dict(), ensure_ascii=False, sort_keys=True) + "\n" for case in cases
        ).encode("utf-8")
        path = root / f"{split}.jsonl"
        path.write_bytes(payload)
        manifest["splits"][split] = {
            "file": path.name,
            "cases": len(cases),
            "episodes": len({case.episode_id for case in cases}),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "regimes": sorted({case.regime for case in cases}),
        }
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def load_cases(path: str | Path) -> tuple[DatasetCase, ...]:
    return tuple(
        DatasetCase.from_dict(json.loads(line))
        for line in Path(path).read_text(encoding="utf-8").splitlines()
        if line.strip()
    )
