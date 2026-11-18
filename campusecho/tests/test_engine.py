from dataclasses import replace

import pytest

from campusecho.engine import analyze
from campusecho.evidence import Evidence
from campusecho.world import Action, Observation, observe, scenario, step


def stable_result(result):
    result = dict(result)
    result["logic_metrics"] = {
        k: v for k, v in result["logic_metrics"].items() if k != "elapsed_seconds"
    }
    return result


def test_same_view_same_result_without_truth_access():
    world = scenario()
    hidden = replace(
        world,
        actors=tuple(
            replace(a, location="venue") if a.actor_id == "xiaxi" else a for a in world.actors
        ),
        seed=900,
    )
    assert stable_result(analyze(observe(world, "player"))) == stable_result(
        analyze(observe(hidden, "player"))
    )


def test_copied_reports_do_not_increase_confidence():
    base = analyze(observe(scenario("conflict"), "player"))
    duplicate = analyze(observe(scenario("duplicate"), "player"))
    assert base["bayes"]["probabilities"] == duplicate["bayes"]["probabilities"]
    for method in ("dempster", "yager"):
        assert (
            base["evidence_methods"][method]["probabilities"]
            == (duplicate["evidence_methods"][method]["probabilities"])
        )
        assert len(duplicate["evidence_methods"][method]["discarded"]) == 10


def test_direct_sighting_drives_rule_and_action():
    result = analyze(observe(scenario("umbrella"), "player"))
    assert result["decision"]["mode"] == "known"
    assert result["decision"]["location"] == "teaching"
    assert any(p["rule"] == "meet-with-item" for p in result["proof"])
    assert any(a["kind"] == "give" for a in result["actions"])


def test_world_event_creates_private_memory():
    world = step(scenario("umbrella"), Action("give", target="xiaxi", item="umbrella", minutes=0))
    for actor in ("player", "xiaxi"):
        result = analyze(observe(world, actor), target="xiaxi")
        assert any(f["predicate"] == "RemembersGift" for f in result["facts"])
    assert not observe(world, "roommate").memories


@pytest.mark.parametrize("name", ["conflict", "duplicate", "umbrella"])
def test_all_probability_outputs_normalized(name):
    result = analyze(observe(scenario(name), "player"))
    for row in [result["bayes"], *result["evidence_methods"].values()]:
        assert sum(row["probabilities"].values()) == pytest.approx(1)


def test_total_conflict_is_an_explicit_result_not_a_crash(monkeypatch):
    # 明确检查未平滑的设计通道；学习模型的正Dirichlet似然另有独立测试。
    monkeypatch.setattr("campusecho.engine.deployed_model", lambda: None)
    records = tuple(
        Observation(Evidence(f"hard-{i}", str(i), str(i), {place}, 1, 20, 20), "xiaxi", ("player",))
        for i, place in enumerate(("library", "club"))
    )
    world = replace(scenario(), observations=records)
    result = analyze(observe(world, "player"))
    assert result["bayes"]["status"] == "zero_likelihood"
    assert result["evidence_methods"]["dempster"]["status"] == "complete_conflict"
    assert result["evidence_methods"]["yager"]["ignorance"] == pytest.approx(1)
    assert result["decision"]["mode"] == "verify"
