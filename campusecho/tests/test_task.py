"""任务回放验证真实状态转换；测试策略只用合法动作，不改写任务结局。"""

import heapq
from dataclasses import asdict, replace

import pytest

from campusecho.world import (
    EDGES,
    PLACES,
    Action,
    AgentView,
    Task,
    WorldState,
    legal_actions,
    observe,
    scenario,
    step,
    task_summary,
    task_summary_view,
)
from campusecho.world_events import EVENT_TEMPLATES, EVENT_TEXTS

FIND = (
    Action("move", target="walkway", minutes=4),
    Action("move", target="club", minutes=4),
    Action("inform", target="xiaxi"),
)
TO_GOAL = (
    Action("move", target="walkway", minutes=4),
    Action("move", target="venue", minutes=7),
)


def replay(world, actions):
    for action in actions:
        assert action in legal_actions(observe(world, action.actor_id))
        world = step(world, action)
    return world


def wait_until(world, tick):
    while world.tick < tick:
        remaining = tick - world.tick
        duration = next(t for t in (5, 2, 1) if t <= remaining)
        world = step(world, Action("wait", minutes=duration))
    return world


def ready(mode="escort", seed=17):
    return replay(scenario("mission", seed), (*FIND, Action("confirm", target="xiaxi", item=mode)))


def test_public_task_contract_and_old_agent_view_construction():
    world = scenario("mission")
    view = observe(world, "player")
    assert view.task.goal_location == "venue"
    assert not view.task.is_informed and not view.task.confirmed
    assert view.task.confirmation_mode == ""
    assert task_summary(world) == task_summary_view(view)
    assert task_summary(world)["progress"]["stage"] == "locating"
    assert task_summary(world)["status"] == "active"
    assert task_summary(world)["outcome"] is None
    assert observe(world, "xiaxi").task is None
    assert observe(world, "roommate").task is None
    assert observe(world, "clubmate").task is None
    assert task_summary(world, "roommate")["status"] == "not_assigned"
    old = AgentView("player", 0, "club", (), (), (), "rain", 60, ("xiaxi",))
    assert old.task is None


def test_public_task_does_not_reveal_hidden_position_schedule_or_busy_periods():
    world = scenario("mission")
    alternate = replace(
        world,
        seed=999,
        actors=tuple(
            replace(a, location="venue") if a.actor_id == "xiaxi" else a for a in world.actors
        ),
        schedules=(),
        busy_periods=(),
    )
    view = observe(world, "player")
    assert view == observe(alternate, "player")
    assert task_summary(world) == task_summary(alternate)
    assert (
        not {"seed", "schedules", "busy_periods", "actors", "triggered_events"}
        & asdict(view).keys()
    )
    assert "location" not in asdict(view.task)
    assert all(event.actor == "player" for event in view.memories)


@pytest.mark.parametrize("seed", [0, 1, 2, 17, 999])
@pytest.mark.parametrize("mode", ["escort", "meet"])
def test_success_requires_real_delivery_confirmation_and_arrival(seed, mode):
    world = ready(mode, seed)
    assert world.tick == 32
    assert world.task.is_informed and world.task.informed_at == 30
    assert world.task.confirmed and world.task.confirmed_at == 32
    assert world.task.status == "active"
    assert observe(world, "xiaxi").task == world.task
    world = replay(world, TO_GOAL)
    assert world.tick == 43
    assert world.actor("player").location == world.actor("xiaxi").location == "venue"
    assert world.task.status == "success"
    assert world.task.settled_at == 43
    assert task_summary(world)["outcome"] == "success"
    saved = WorldState.from_json(world.to_json())
    assert saved == world
    assert step(saved, Action("wait")) == step(world, Action("wait"))


def test_meet_moves_independently_and_reaching_venue_alone_is_insufficient():
    world = ready("meet")
    assert world.actor("xiaxi").location == "transit"
    world = wait_until(world, 36)
    # 两段最短路衔接时刻，第一段已到达并立即开始第二段。
    assert world.actor("xiaxi").location == "transit"
    world = wait_until(world, 43)
    assert world.actor("xiaxi").location == "venue"
    assert world.actor("player").location == "club"
    assert world.task.status == "active"
    world = replay(world, TO_GOAL)
    assert world.task.status == "success" and world.task.settled_at == 54


def test_escort_does_not_teleport_a_separated_companion():
    world = ready("escort")
    # 开发者角色切换仍通过真实动作改变位置，不能自动把远处同伴吸附到玩家身边。
    world = step(world, Action("move", actor_id="xiaxi", target="library", minutes=6))
    world = replay(world, TO_GOAL)
    assert world.actor("xiaxi").location == "library"
    assert world.actor("player").location == "venue"
    assert world.task.status == "active"


def test_arriving_without_informing_or_confirming_never_succeeds():
    world = replay(
        scenario("mission"),
        (
            Action("move", target="walkway", minutes=4),
            Action("move", target="venue", minutes=7),
        ),
    )
    world = wait_until(world, 59)
    assert world.actor("xiaxi").location == "venue"
    assert world.task.status == "active"
    world = wait_until(world, 60)
    assert world.task.status == "missed"
    assert not world.task.is_informed and not world.task.confirmed


def test_exact_deadline_arrival_is_success_and_overrun_is_missed():
    on_time = replay(wait_until(ready(), 49), TO_GOAL)
    assert on_time.tick == 60
    assert on_time.task.status == "success" and on_time.task.settled_at == 60
    late = replay(wait_until(ready(), 54), TO_GOAL)
    assert late.tick == 65
    assert late.actor("player").location == late.actor("xiaxi").location == "venue"
    assert late.task.status == "missed" and late.task.settled_at == 60
    assert step(late, Action("wait")).task.status == "missed"
    assert not any(
        a.kind in {"inform", "confirm", "reschedule"}
        for a in legal_actions(observe(late, "player"))
    )


def test_deadline_cannot_be_repaired_by_late_information_or_confirmation():
    world = wait_until(scenario("mission"), 60)
    assert world.task.status == "missed"
    with pytest.raises(ValueError, match="前置"):
        step(world, Action("inform", target="xiaxi"))
    with pytest.raises(ValueError, match="前置"):
        step(world, Action("confirm", target="xiaxi", item="escort"))
    assert len([e for e in world.events if e.template_id == "mission-missed"]) == 1


def test_two_minute_conversation_cannot_complete_after_deadline():
    world = replay(scenario("mission"), FIND)
    world = wait_until(world, 59)
    assert world.actor("player").location == world.actor("xiaxi").location
    assert not any(a.kind == "confirm" for a in legal_actions(observe(world, "player")))
    with pytest.raises(ValueError, match="前置"):
        step(world, Action("confirm", target="xiaxi", item="escort"))
    assert wait_until(world, 60).task.status == "missed"


def test_reschedule_is_an_explicit_distinct_terminal_outcome():
    world = replay(scenario("mission"), FIND)
    world = step(world, Action("reschedule", target="xiaxi"))
    assert world.task.status == "rescheduled" and world.task.settled_at == 32
    assert task_summary(world)["outcome"] == "rescheduled"
    assert not world.task.confirmed
    assert wait_until(world, 65).task.status == "rescheduled"
    with pytest.raises(ValueError, match="前置"):
        step(world, Action("reschedule", target="xiaxi"))


def test_task_action_preconditions_and_one_time_flags():
    world = scenario("mission")
    with pytest.raises(ValueError, match="前置"):
        step(world, Action("inform", target="xiaxi"))
    found = replay(world, FIND[:2])
    with pytest.raises(ValueError, match="前置"):
        step(found, Action("confirm", target="xiaxi", item="escort"))
    informed = step(found, FIND[2])
    with pytest.raises(ValueError, match="前置"):
        step(informed, Action("inform", target="xiaxi"))
    with pytest.raises(ValueError, match="前置"):
        step(informed, Action("confirm", target="xiaxi"))
    confirmed = step(informed, Action("confirm", target="xiaxi", item="escort"))
    with pytest.raises(ValueError, match="前置"):
        step(confirmed, Action("confirm", target="xiaxi", item="meet"))
    completed = wait_until(replay(confirmed, TO_GOAL), 65)
    ids = [e.event_id for e in completed.events]
    assert len(ids) == len(set(ids))
    assert len(completed.triggered_events) == len(set(completed.triggered_events))
    assert sorted(e.template_id for e in completed.events if e.template_id) == [
        "appointment-confirmed",
        "mission-success",
        "venue-informed",
    ]


def test_templates_have_executable_conditions_effects_and_separate_text_ids():
    assert len(EVENT_TEMPLATES) == 5
    assert len({t.template_id for t in EVENT_TEMPLATES}) == 5
    assert all(
        t.conditions and t.effects and t.once and t.text_id in EVENT_TEXTS for t in EVENT_TEMPLATES
    )
    world = replay(ready(), TO_GOAL)
    for event in world.events:
        if event.template_id:
            template = next(t for t in EVENT_TEMPLATES if t.template_id == event.template_id)
            assert event.text_id == template.text_id
            assert EVENT_TEXTS[event.text_id] in event.detail


@pytest.mark.parametrize("outcome", ["success", "rescheduled", "missed"])
def test_full_save_load_replay_for_each_ending(outcome):
    world = replay(scenario("mission"), FIND)
    saved = WorldState.from_json(world.to_json())
    assert saved == world
    assert saved.schedules and saved.busy_periods and saved.triggered_events
    if outcome == "rescheduled":
        actions = (Action("reschedule", target="xiaxi"),)
    else:
        actions = (Action("confirm", target="xiaxi", item="escort"),)
        if outcome == "success":
            actions += TO_GOAL
        else:
            actions += (Action("wait", minutes=5),) * 6
    final, restored = replay(world, actions), replay(saved, actions)
    assert final == restored
    assert final.task.status == outcome
    assert WorldState.from_json(final.to_json()) == final


@pytest.mark.parametrize(
    "updates",
    [
        {"confirmed": True},
        {"is_informed": True},
        {"status": "success", "settled_at": 1},
        {"status": "rescheduled", "settled_at": 1},
        {"status": "missed", "settled_at": 61},
    ],
)
def test_inconsistent_task_snapshots_are_rejected(updates):
    with pytest.raises(ValueError):
        replace(Task(), **updates)


@pytest.fixture(scope="module")
def challenge_worlds():
    return tuple(scenario("challenge", seed) for seed in range(50))


def shortest_actions(origin, destination):
    """测试独立实现最短路，不调用世界的私有规划器。"""
    queue = [(0, origin, ())]
    seen = set()
    while queue:
        distance, place, actions = heapq.heappop(queue)
        if place in seen:
            continue
        seen.add(place)
        if place == destination:
            return tuple(Action("move", target=target, minutes=cost) for target, cost in actions)
        for start, end, cost in EDGES:
            if place in (start, end):
                other = end if start == place else start
                heapq.heappush(queue, (distance + cost, other, (*actions, (other, cost))))
    raise AssertionError("校园地图不可达")


def historical_truth(world, actor_id, at):
    """审计器从完整移动日志独立还原时刻位置，仅用于测试查验线索。"""
    legs = sorted(
        (leg for leg in world.schedules if leg.actor_id == actor_id), key=lambda leg: leg.depart_at
    )
    location = legs[0].origin if legs else world.actor(actor_id).location
    for leg in legs:
        if at < leg.depart_at:
            break
        if at < leg.arrive_at:
            return "transit"
        location = leg.destination
    return location


def oracle_find(world):
    # 此处明确读取真值作为评测上界；oracle 没有进入角色视图或正式策略接口。
    return replay(
        world, shortest_actions(world.actor("player").location, world.actor("xiaxi").location)
    )


def oracle_success(world, mode="escort"):
    world = oracle_find(world)
    world = replay(
        world,
        (
            Action("inform", target="xiaxi"),
            Action("confirm", target="xiaxi", item=mode),
        ),
    )
    return replay(world, shortest_actions(observe(world, "player").location, "venue"))


def test_challenge_fifty_seeds_have_real_state_route_and_observation_diversity(challenge_worlds):
    worlds = challenge_worlds
    assert {world.actor("xiaxi").location for world in worlds} == set(PLACES)
    assert {world.actor("player").location for world in worlds} == set(PLACES)
    for actor_id in ("roommate", "clubmate"):
        assert {world.actor(actor_id).location for world in worlds} == set(PLACES) | {"transit"}
    assert (
        len({tuple((actor.actor_id, actor.location) for actor in world.actors) for world in worlds})
        >= 40
    )
    # 比较路线节点序列，而非仅比较种子、ID 或出发时间。
    routes = {
        tuple(
            (leg.actor_id, leg.origin, leg.destination)
            for leg in world.schedules
            if leg.depart_at <= world.deadline
        )
        for world in worlds
    }
    assert len(routes) == 50
    assert len({world.deadline - world.tick for world in worlds}) >= 10
    assert {world.weather for world in worlds} == {"clear", "rain", "showers"}
    assert len({world.busy_periods for world in worlds}) == 50
    reports = set()
    ages = set()
    for world in worlds:
        initial = tuple(o for o in observe(world, "player").observations if o.kind == "report")
        reports.add(
            tuple(
                (o.evidence.source_id, tuple(sorted(o.evidence.support)), o.evidence.observed_at)
                for o in initial
            )
        )
        ages.update(world.tick - o.evidence.observed_at for o in initial)
    assert len(reports) >= 40
    assert len(ages) >= 10


def test_challenge_initial_reports_have_real_historical_witnesses(challenge_worlds):
    sources = set()
    for world in challenge_worlds:
        view = observe(world, "player")
        initial = [o for o in view.observations if o.kind == "report"]
        assert {"roommate", "clubmate"} <= {o.evidence.source_id for o in initial}
        for record in initial:
            evidence = record.evidence
            sources.add(evidence.source_id)
            assert 0 <= evidence.observed_at <= evidence.received_at <= world.tick
            actual = historical_truth(world, "xiaxi", evidence.observed_at)
            assert actual != "transit"
            assert evidence.support == {actual}
            if evidence.source_id in {"roommate", "clubmate"}:
                assert historical_truth(world, evidence.source_id, evidence.observed_at) == actual
        assert historical_truth(world, "xiaxi", world.tick) == world.actor("xiaxi").location
        assert all(leg.arrive_at > leg.depart_at for leg in world.schedules)
    assert sources == {"roommate", "clubmate", "camera"}


def test_challenge_fifty_seed_oracle_completes_using_only_legal_actions(challenge_worlds):
    completed = []
    for world in challenge_worlds:
        mode = "escort" if world.seed % 2 else "meet"
        final = oracle_success(world, mode)
        assert final.actor("player").location == final.actor("xiaxi").location == "venue"
        assert final.task.is_informed and final.task.confirmed
        assert final.tick <= world.deadline
        assert final.task.settled_at <= world.deadline
        assert final.task.status == "success"
        completed.append(final.task.status)
    assert completed.count("success") == 50


def test_challenge_three_terminal_outcomes_are_reachable_and_replay_exactly(challenge_worlds):
    for initial in challenge_worlds[:5]:
        restored = WorldState.from_json(initial.to_json())
        assert restored == initial
        success = oracle_success(initial)
        assert oracle_success(restored) == success
        found = oracle_find(initial)
        rescheduled = replay(
            found, (Action("inform", target="xiaxi"), Action("reschedule", target="xiaxi"))
        )
        assert rescheduled.task.status == "rescheduled"
        missed = wait_until(initial, initial.deadline)
        assert missed.task.status == "missed" and missed.task.settled_at == initial.deadline
        for final in (success, rescheduled, missed):
            assert WorldState.from_json(final.to_json()) == final
            assert step(final, Action("wait")).task.status == final.task.status


def test_challenge_still_enforces_the_same_public_information_boundary(challenge_worlds):
    world = next(
        w for w in challenge_worlds if w.actor("player").location != w.actor("xiaxi").location
    )
    other_place = next(
        place
        for place in PLACES
        if place not in {world.actor("player").location, world.actor("xiaxi").location}
    )
    alternate = replace(
        world,
        seed=999999,
        schedules=(),
        busy_periods=(),
        actors=tuple(
            replace(actor, location=other_place) if actor.actor_id == "xiaxi" else actor
            for actor in world.actors
        ),
    )
    view = observe(world, "player")
    assert view == observe(alternate, "player")
    assert task_summary_view(view) == task_summary(alternate)
    assert not {"schedules", "busy_periods", "seed", "actors"} & asdict(view).keys()
    assert observe(world, "xiaxi").task is None


def test_challenge_wrong_public_location_policy_can_fail_despite_oracle_solvability(
    challenge_worlds,
):
    successes = 0
    failures = 0
    for world in challenge_worlds:
        # 固定去社团室的朴素策略只看公开位置与当前目击；不会偷读目标位置。
        world = replay(world, shortest_actions(observe(world, "player").location, "club"))
        for candidate in (
            Action("inform", target="xiaxi"),
            Action("confirm", target="xiaxi", item="escort"),
        ):
            if candidate in legal_actions(observe(world, "player")):
                world = step(world, candidate)
        if world.task.confirmed:
            world = replay(world, shortest_actions(observe(world, "player").location, "venue"))
        if world.task.status == "active":
            world = wait_until(world, world.deadline)
        successes += world.task.status == "success"
        failures += world.task.status == "missed"
    assert successes > 0
    assert failures > 0
    assert successes + failures == 50
