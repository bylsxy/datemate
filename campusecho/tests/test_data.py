"""独立轨迹、分割隔离、真值投影及可复现数据文件。"""

import hashlib
import json
from collections import defaultdict
from dataclasses import replace

import pytest

from campusecho.data import (
    SOURCES,
    DatasetCase,
    generate_dataset,
    load_cases,
    time_of_day,
    write_dataset,
)
from campusecho.world import FRAME


def small_data(**kwargs):
    return generate_dataset(train_episodes=6, val_episodes=3, test_episodes=9, **kwargs)


def test_generation_is_seeded_and_split_streams_do_not_depend_on_other_split_sizes():
    first = small_data(seed=53)
    assert first == small_data(seed=53)
    assert first != small_data(seed=54)
    changed_train = generate_dataset(seed=53, train_episodes=1, val_episodes=3, test_episodes=9)
    assert first["val"] == changed_train["val"]
    assert first["test"] == changed_train["test"]


def test_episode_split_and_noise_variants_never_leak_or_change_latent_path():
    dataset = small_data(seed=77, noise_variants=2)
    episode_sets = [{case.episode_id for case in cases} for cases in dataset.values()]
    assert all(
        not left & right
        for index, left in enumerate(episode_sets)
        for right in episode_sets[index + 1 :]
    )
    grouped = defaultdict(list)
    for split, cases in dataset.items():
        for case in cases:
            assert case.split == split
            grouped[case.episode_id].append(case)
    for cases in grouped.values():
        assert len(cases) == 6
        assert {case.variant_id for case in cases} == {0, 1}
        assert len({case.now for case in cases}) == 3
        for now in {case.now for case in cases}:
            at_time = [case for case in cases if case.now == now]
            assert len({case.truth for case in at_time}) == 1
            assert len({tuple(case.context.items()) for case in at_time}) == 1
    assert any(cases[0].evidence != cases[3].evidence for cases in grouped.values())


def test_snapshots_have_visible_delayed_reports_copies_motion_and_test_shifts():
    dataset = small_data(seed=91)
    cases = [case for rows in dataset.values() for case in rows]
    assert {case.regime for case in dataset["train"] + dataset["val"]} == {"iid"}
    assert {case.regime for case in dataset["test"]} == {
        "iid",
        "mobility_shift",
        "reliability_shift",
    }
    assert "transit" in {case.truth for case in cases}
    assert len({case.truth for case in cases}) >= 5
    all_evidence = [item for case in cases for item in case.evidence]
    assert set(SOURCES) <= {item.source_id for item in all_evidence}
    assert any(item.source_id.startswith("relay-") for item in all_evidence)
    assert any(item.support is None for item in all_evidence)
    assert any(item.observed_at < item.received_at for item in all_evidence)
    for case in cases:
        assert case.truth in FRAME
        assert case.context["time_of_day"] == time_of_day(case.now)
        assert all(item.observed_at <= item.received_at <= case.now for item in case.evidence)
        assert all(item.support is None or item.support <= FRAME for item in case.evidence)


def test_inference_projection_is_frozen_and_contains_no_labels_or_identifiers():
    case = small_data()["test"][0]
    inputs = case.inference_inputs()
    assert len(inputs) == 3
    assert (
        inputs
        == replace(
            case, truth=next(state for state in FRAME if state != case.truth)
        ).inference_inputs()
    )
    assert set(inputs[2]) == {"time_of_day", "weather"}
    inputs[2]["weather"] = "changed"
    assert case.context["weather"] in ("clear", "rain")
    with pytest.raises(TypeError):
        case.context["weather"] = "rain"


def test_jsonl_manifest_roundtrip_and_content_fingerprints(tmp_path):
    dataset = small_data(seed=12)
    manifest = write_dataset(tmp_path, dataset)
    assert manifest == json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["inference_model_used_by_generator"] is False
    assert manifest["test_frozen"] is True
    for split, expected_episodes in (("train", 6), ("val", 3), ("test", 9)):
        assert load_cases(tmp_path / f"{split}.jsonl") == dataset[split]
        entry = manifest["splits"][split]
        assert entry["episodes"] == expected_episodes
        assert entry["cases"] == expected_episodes * 3
        assert (
            entry["sha256"]
            == hashlib.sha256((tmp_path / f"{split}.jsonl").read_bytes()).hexdigest()
        )


def test_manifest_refuses_cross_split_episode_even_if_case_ids_differ(tmp_path):
    dataset = small_data()
    train = dataset["train"][0]
    val = replace(dataset["val"][0], episode_id=train.episode_id)
    dataset["val"] = (val, *dataset["val"][1:])
    with pytest.raises(ValueError, match="跨分割"):
        write_dataset(tmp_path, dataset)
    assert not (tmp_path / "manifest.json").exists()


def test_generator_never_calls_inference_model(monkeypatch):
    from campusecho.bayes import LocationBayes
    from campusecho.learned import LearnedLocationModel

    def forbidden(*args, **kwargs):
        raise AssertionError("轨迹生成不允许读取推理模型")

    monkeypatch.setattr(LocationBayes, "infer", forbidden)
    monkeypatch.setattr(LearnedLocationModel, "infer", forbidden)
    assert len(small_data()["train"]) == 18


@pytest.mark.parametrize(
    "kwargs", [{"snapshots": 0}, {"noise_variants": 0}, {"train_episodes": -1}]
)
def test_invalid_generation_sizes(kwargs):
    with pytest.raises(ValueError):
        generate_dataset(**kwargs)


def test_bad_dataset_schema_is_rejected():
    case = small_data()["train"][0]
    with pytest.raises(ValueError, match="schema"):
        DatasetCase.from_dict({**case.to_dict(), "schema_version": 99})
