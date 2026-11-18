from dataclasses import replace

import pytest

from campusecho.evidence import Evidence
from campusecho.world import (
    Action,
    Actor,
    Event,
    Observation,
    WorldState,
    legal_actions,
    observe,
    scenario,
    step,
)


def test_hidden_world_is_not_in_agent_view():
    world = scenario()
    alternate = replace(
        world,
        actors=tuple(
            replace(a, location="venue") if a.actor_id == "xiaxi" else a for a in world.actors
        ),
        seed=999,
    )
    assert observe(world, "player") == observe(alternate, "player")
    assert not hasattr(observe(world, "player"), "seed")
    assert observe(world, "roommate").observations == ()


def test_current_sighting_has_explicit_source():
    view = observe(scenario("umbrella"), "player")
    direct = [o for o in view.observations if o.kind == "sighting"]
    assert len(direct) == 1
    assert direct[0].evidence.support == {"teaching"}
    assert direct[0].evidence.observed_at == view.tick


def test_cannot_give_remotely_or_duplicate_an_item():
    with pytest.raises(ValueError, match="前置"):
        step(scenario(), Action("give", target="xiaxi", item="umbrella", minutes=0))
    world = step(scenario("umbrella"), Action("give", target="xiaxi", item="umbrella", minutes=0))
    assert world.ownership == (("umbrella", "xiaxi"),)
    assert "umbrella" not in observe(world, "player").possessions
    with pytest.raises(ValueError):
        step(world, Action("give", target="xiaxi", item="umbrella", minutes=0))


def test_legal_moves_and_action_time_are_checked():
    world = scenario()
    action = Action("move", target="library", minutes=5)
    result = step(world, action)
    assert result.tick == 25
    assert result.actor("player").location == "library"
    with pytest.raises(ValueError):
        step(world, replace(action, minutes=0))


@pytest.mark.parametrize("name", ["conflict", "duplicate", "umbrella"])
def test_snapshot_round_trip_and_action_replay(name):
    world = scenario(name)
    saved = WorldState.from_json(world.to_json())
    assert saved == world
    action = next(
        a
        for a in legal_actions(observe(world, "player"))
        if a.kind == "ask" and a.target == "xiaxi"
    )
    assert step(world, action) == step(saved, action)
    assert world.tick == 20


def test_state_invariants():
    with pytest.raises(ValueError, match="持有人"):
        replace(scenario(), ownership=(("umbrella", "player"), ("umbrella", "xiaxi")))
    with pytest.raises(ValueError, match="角色ID"):
        replace(scenario(), actors=(Actor("player", "teaching"), Actor("player", "library")))


def test_future_observations_and_memories_are_hidden():
    world = scenario()
    record = Observation(
        Evidence("future", "source", "future", {"library"}, 1, 999, 0), "xiaxi", ("player",)
    )
    event = Event("future", 999, "ask", "player", "xiaxi", "秘密", ("player",))
    world = replace(world, observations=(record,), events=(event,))
    view = observe(WorldState.from_json(world.to_json()), "player")
    assert view.observations == ()
    assert view.memories == ()


def test_untrusted_sighting_cannot_be_persisted():
    record = Observation(
        Evidence("fake", "roommate", "fake", {"teaching"}, 1, 20, 20),
        "xiaxi",
        ("player",),
        "sighting",
    )
    with pytest.raises(ValueError, match="目击"):
        replace(scenario(), observations=(record,))


def test_snapshot_detaches_external_containers():
    external = list(scenario().actors)
    world = replace(scenario(), actors=external)
    external.clear()
    assert len(world.actors) == 4


def test_actions_only_reference_existing_contacts():
    world = replace(
        scenario(), actors=(Actor("player", "teaching"),), observations=(), ownership=()
    )
    assert not any(a.kind == "ask" for a in legal_actions(observe(world, "player")))


def test_visibility_lists_are_detached_from_external_mutation():
    viewers = ["player"]
    evidence = Evidence("report", "source", "origin", {"club"}, 0.8, 0, 0)
    record = Observation(evidence, "xiaxi", viewers)
    event = Event("gift", 0, "give", "player", "xiaxi", "伞", viewers)
    viewers.append("roommate")
    assert record.viewers == ("player",)
    assert event.visible_to == ("player",)


def test_mission_npc_departures_transit_and_arrivals_advance_with_player_time():
    world = scenario("mission", 17)
    assert len(world.actors) == 4
    assert world.actor("roommate").location == "transit"
    world = step(world, Action("wait", minutes=1))
    assert world.actor("clubmate").location == "transit"
    world = step(world, Action("wait", minutes=1))
    assert world.actor("roommate").location == "walkway"
    for _ in range(5):
        world = step(world, Action("wait"))
    assert world.tick == 32
    assert world.actor("xiaxi").location == "transit"
    world = step(step(world, Action("wait")), Action("wait"))
    assert world.tick == 36
    assert world.actor("xiaxi").location == "walkway"
    assert world.actor("clubmate").location == "transit"
    for actor in ("xiaxi", "roommate", "clubmate"):
        assert any(e.actor == actor and e.kind == "departure" for e in world.events)
        assert any(e.actor == actor and e.kind == "arrival" for e in world.events)


def test_mission_old_evidence_was_true_then_but_is_stale_now():
    world = scenario("mission", 17)
    photo = next(
        o.evidence
        for o in observe(world, "player").observations
        if o.evidence.evidence_id == "old-photo"
    )
    first_leg = next(s for s in world.schedules if s.actor_id == "xiaxi")
    assert photo.support == {first_leg.origin} == {"library"}
    assert photo.observed_at < first_leg.depart_at
    assert world.actor("xiaxi").location == "club"
    assert world.actor("xiaxi").location not in photo.support


def test_asking_roommate_is_about_xiaxi_and_preserves_old_observation_time():
    world = step(scenario("mission", 17), Action("ask", target="roommate"))
    reply = next(
        o
        for o in observe(world, "player").observations
        if o.evidence.evidence_id.startswith("reply:")
    )
    assert reply.target == "xiaxi"
    assert reply.evidence.source_id == "roommate"
    assert reply.evidence.support == {"library"}
    assert reply.evidence.observed_at < 20 < reply.evidence.received_at
    assert world.actor("roommate").location == "walkway"
    assert world.actor("xiaxi").location == "club"


def test_busy_target_can_fail_to_reply_and_direct_reply_has_direct_source():
    world = step(scenario("mission", 17), Action("ask", target="xiaxi"))
    assert not any(
        o.evidence.evidence_id.startswith("reply:") for o in observe(world, "player").observations
    )
    assert "忙碌" in next(e.detail for e in world.events if e.kind == "ask")
    world = step(world, Action("wait", minutes=5))
    assert world.tick == 27
    # 随机回复有失败概率；固定候选种子中必须存在可复现的本人成功回复。
    replies = []
    for seed in range(10):
        before = replace(world, seed=seed)
        after = step(before, Action("ask", target="xiaxi"))
        replies.extend(
            o.evidence
            for o in observe(after, "player").observations
            if o.evidence.evidence_id.startswith("reply:")
        )
        assert step(WorldState.from_json(before.to_json()), Action("ask", target="xiaxi")) == after
    assert replies and all(e.source_id == "direct" for e in replies)


def test_private_schedule_logs_do_not_leak_through_player_memories():
    world = step(scenario("mission"), Action("wait", minutes=5))
    view = observe(world, "player")
    assert any(e.kind in {"departure", "arrival"} for e in world.events)
    assert all(e.kind not in {"departure", "arrival"} for e in view.memories)


def test_mission_nested_state_containers_are_frozen_and_round_trip():
    base = scenario("mission")
    schedules, busy, flags = (
        list(base.schedules),
        list(base.busy_periods),
        list(base.triggered_events),
    )
    world = replace(base, schedules=schedules, busy_periods=busy, triggered_events=flags)
    schedules.clear()
    busy.clear()
    flags.clear()
    assert world.schedules and world.busy_periods and world.triggered_events
    assert WorldState.from_json(world.to_json()) == world
