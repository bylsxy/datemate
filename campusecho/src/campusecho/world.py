"""有限校园世界；所有可变结果通过新快照返回，推理器只接收 AgentView。"""

from __future__ import annotations

import hashlib
import heapq
import json
import random
from dataclasses import asdict, dataclass, replace
from itertools import pairwise

from .evidence import Evidence
from .world_events import EVENT_TEMPLATES, EVENT_TEXTS

PLACES = {
    "teaching": "教学楼",
    "library": "图书馆",
    "club": "社团室",
    "canteen": "食堂",
    "walkway": "有顶连廊",
    "venue": "活动会场",
}
FRAME = frozenset((*PLACES, "transit"))
EDGES = (
    ("teaching", "library", 5),
    ("teaching", "walkway", 4),
    ("library", "club", 6),
    ("club", "walkway", 4),
    ("walkway", "canteen", 5),
    ("walkway", "venue", 7),
    ("canteen", "venue", 8),
)
_DIRECTED_EDGES = frozenset(EDGES) | frozenset((b, a, d) for a, b, d in EDGES)


@dataclass(frozen=True)
class Actor:
    actor_id: str
    location: str


@dataclass(frozen=True)
class ScheduleLeg:
    """私有日程中的一段实际移动；角色视图不包含此对象。"""

    actor_id: str
    origin: str
    destination: str
    depart_at: int
    arrive_at: int

    @property
    def leg_id(self) -> str:
        # 标识会进入当事人的事件视图，不将未到达的目的地和到达时间编码在公开 ID 中。
        key = f"{self.actor_id}:{self.origin}:{self.destination}:{self.depart_at}:{self.arrive_at}"
        return hashlib.sha256(key.encode()).hexdigest()[:24]


@dataclass(frozen=True)
class BusyPeriod:
    actor_id: str
    start: int
    end: int


@dataclass(frozen=True)
class Task:
    """任务参与者已知的进度；不保存目标的真实位置或未公开日程。"""

    task_id: str = "venue-change"
    owner: str = "player"
    target: str = "xiaxi"
    goal_location: str = "venue"
    deadline: int = 60
    status: str = "active"
    is_informed: bool = False
    confirmed: bool = False
    confirmation_mode: str = ""
    informed_at: int | None = None
    confirmed_at: int | None = None
    settled_at: int | None = None

    def __post_init__(self):
        if self.status not in {"active", "success", "rescheduled", "missed"}:
            raise ValueError("任务状态无效")
        if self.goal_location not in PLACES or type(self.deadline) is not int or self.deadline < 0:
            raise ValueError("任务目标或截止时间无效")
        if self.confirmation_mode not in {"", "escort", "meet"}:
            raise ValueError("确认方式无效")
        if type(self.is_informed) is not bool or type(self.confirmed) is not bool:
            raise ValueError("任务进度必须使用布尔值")
        if self.is_informed != (self.informed_at is not None):
            raise ValueError("任务传达状态不一致")
        if self.confirmed != (self.confirmed_at is not None and bool(self.confirmation_mode)):
            raise ValueError("任务确认状态不一致")
        if not self.confirmed and (self.confirmed_at is not None or self.confirmation_mode):
            raise ValueError("未确认任务不能保存确认方式")
        if self.confirmed and not self.is_informed:
            raise ValueError("确认必须先传达改址")
        times = (self.informed_at, self.confirmed_at, self.settled_at)
        if any(
            t is not None and (type(t) is not int or not 0 <= t <= self.deadline) for t in times
        ):
            raise ValueError("任务时间超出截止范围")
        if self.confirmed and self.confirmed_at < self.informed_at:
            raise ValueError("任务时间顺序无效")
        if (self.status == "active") != (self.settled_at is None):
            raise ValueError("任务结算状态不一致")
        if self.status == "success" and not self.confirmed:
            raise ValueError("成功任务必须已经确认")
        if self.status == "rescheduled" and not self.is_informed:
            raise ValueError("改约必须先传达")
        if self.status == "missed" and self.settled_at != self.deadline:
            raise ValueError("错过任务必须在截止时刻结算")
        if self.status == "success" and self.settled_at < self.confirmed_at:
            raise ValueError("任务结算不能早于确认")
        if self.status == "rescheduled" and self.settled_at < self.informed_at:
            raise ValueError("任务改约不能早于传达")


@dataclass(frozen=True)
class Observation:
    evidence: Evidence
    target: str
    viewers: tuple[str, ...]
    kind: str = "report"

    def __post_init__(self):
        object.__setattr__(self, "viewers", tuple(self.viewers))


@dataclass(frozen=True)
class Event:
    event_id: str
    tick: int
    kind: str
    actor: str
    target: str
    detail: str
    visible_to: tuple[str, ...]
    template_id: str = ""
    text_id: str = ""

    def __post_init__(self):
        object.__setattr__(self, "visible_to", tuple(self.visible_to))


@dataclass(frozen=True)
class WorldState:
    seed: int
    tick: int
    actors: tuple[Actor, ...]
    ownership: tuple[tuple[str, str], ...]
    observations: tuple[Observation, ...] = ()
    events: tuple[Event, ...] = ()
    weather: str = "rain"
    deadline: int = 60
    schema_version: int = 1
    task: Task | None = None
    schedules: tuple[ScheduleLeg, ...] = ()
    busy_periods: tuple[BusyPeriod, ...] = ()
    triggered_events: tuple[str, ...] = ()

    def __post_init__(self):
        # 冻结嵌套容器，避免调用方在验证后通过原始列表修改快照。
        object.__setattr__(self, "actors", tuple(self.actors))
        object.__setattr__(self, "ownership", tuple(tuple(p) for p in self.ownership))
        object.__setattr__(self, "observations", tuple(self.observations))
        object.__setattr__(self, "events", tuple(self.events))
        object.__setattr__(self, "schedules", tuple(self.schedules))
        object.__setattr__(self, "busy_periods", tuple(self.busy_periods))
        object.__setattr__(self, "triggered_events", tuple(self.triggered_events))
        if self.schema_version != 1:
            raise ValueError("不支持的世界状态版本")
        ids = [a.actor_id for a in self.actors]
        if len(ids) != len(set(ids)) or not ids:
            raise ValueError("角色ID必须唯一")
        if (
            type(self.tick) is not int
            or type(self.deadline) is not int
            or self.tick < 0
            or self.deadline < 0
        ):
            raise ValueError("游戏时间必须非负")
        if any(a.location not in FRAME for a in self.actors):
            raise ValueError("角色位置超出识别框架")
        items = [item for item, _ in self.ownership]
        if len(items) != len(set(items)):
            raise ValueError("同一物品只能有一个持有人")
        if any(owner not in ids for _, owner in self.ownership):
            raise ValueError("物品持有人不存在")
        if any(o.target not in ids or not set(o.viewers) <= set(ids) for o in self.observations):
            raise ValueError("观察引用了不存在的角色")
        if any(o.kind != "report" for o in self.observations):
            raise ValueError("持久化观察只能保存报告；当前目击由观察投影器产生")
        if len({e.event_id for e in self.events}) != len(self.events):
            raise ValueError("事件ID重复")
        if len(set(self.triggered_events)) != len(self.triggered_events):
            raise ValueError("一次性事件标记重复")
        if self.task is not None:
            if self.task.owner not in ids or self.task.target not in ids:
                raise ValueError("任务参与者不存在")
            if self.task.owner == self.task.target or self.task.deadline != self.deadline:
                raise ValueError("任务参与者或截止时间不一致")
        for leg in self.schedules:
            if (
                leg.actor_id not in ids
                or type(leg.depart_at) is not int
                or type(leg.arrive_at) is not int
                or leg.depart_at < 0
                or (leg.origin, leg.destination, leg.arrive_at - leg.depart_at)
                not in _DIRECTED_EDGES
            ):
                raise ValueError("角色日程必须是合法地图移动")
        for actor_id in ids:
            legs = sorted(
                (s for s in self.schedules if s.actor_id == actor_id), key=lambda s: s.depart_at
            )
            if any(a.arrive_at > b.depart_at for a, b in pairwise(legs)):
                raise ValueError("同一角色的移动日程不能重叠")
            if any(a.destination != b.origin for a, b in pairwise(legs)):
                raise ValueError("角色日程必须连续")
        if any(
            p.actor_id not in ids
            or type(p.start) is not int
            or type(p.end) is not int
            or not 0 <= p.start < p.end
            for p in self.busy_periods
        ):
            raise ValueError("忙碌时间无效")

    def actor(self, actor_id: str) -> Actor:
        try:
            return next(a for a in self.actors if a.actor_id == actor_id)
        except StopIteration as exc:
            raise ValueError("角色不存在") from exc

    def to_json(self) -> str:
        data = asdict(self)
        for row in data["observations"]:
            support = row["evidence"]["support"]
            row["evidence"]["support"] = sorted(support) if support is not None else None
        return json.dumps(data, ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> WorldState:
        data = json.loads(text)
        data["actors"] = tuple(Actor(**a) for a in data["actors"])
        data["ownership"] = tuple(tuple(pair) for pair in data["ownership"])
        observations = []
        for row in data.pop("observations", []):
            evidence = Evidence(**row["evidence"])
            observations.append(
                Observation(evidence, row["target"], tuple(row["viewers"]), row["kind"])
            )
        data["observations"] = tuple(observations)
        data["events"] = tuple(
            Event(**{**e, "visible_to": tuple(e["visible_to"])}) for e in data.get("events", [])
        )
        if data.get("task") is not None:
            data["task"] = Task(**data["task"])
        data["schedules"] = tuple(ScheduleLeg(**s) for s in data.get("schedules", []))
        data["busy_periods"] = tuple(BusyPeriod(**p) for p in data.get("busy_periods", []))
        return cls(**data)


@dataclass(frozen=True)
class AgentView:
    actor_id: str
    tick: int
    location: str
    possessions: tuple[str, ...]
    observations: tuple[Observation, ...]
    memories: tuple[Event, ...]
    weather: str
    deadline: int
    contacts: tuple[str, ...]
    task: Task | None = None

    def evidence_for(self, target: str) -> tuple[Evidence, ...]:
        records = tuple(o.evidence for o in self.observations if o.target == target)
        if target == self.actor_id:
            records += (
                Evidence(
                    f"self:{self.actor_id}:{self.tick}",
                    self.actor_id,
                    f"self:{self.actor_id}:{self.tick}",
                    frozenset({self.location}),
                    1.0,
                    self.tick,
                    self.tick,
                ),
            )
        return records


def observe(world: WorldState, actor_id: str) -> AgentView:
    """只有收到的记录和当前亲眼所见会进入角色视图；不传递世界种子。"""
    actor = world.actor(actor_id)
    records = [
        o
        for o in world.observations
        if (
            actor_id in o.viewers
            and o.evidence.received_at <= world.tick
            and o.evidence.observed_at <= world.tick
        )
    ]
    for other in world.actors:
        if other.actor_id != actor_id and other.location == actor.location != "transit":
            evidence = Evidence(
                f"sight:{actor_id}:{other.actor_id}:{world.tick}",
                actor_id,
                f"sight:{actor_id}:{other.actor_id}:{world.tick}",
                frozenset({other.location}),
                1.0,
                world.tick,
                world.tick,
            )
            records.append(Observation(evidence, other.actor_id, (actor_id,), "sighting"))
    return AgentView(
        actor_id,
        world.tick,
        actor.location,
        tuple(sorted(item for item, owner in world.ownership if owner == actor_id)),
        tuple(sorted(records, key=lambda o: o.evidence.evidence_id)),
        tuple(e for e in world.events if actor_id in e.visible_to and e.tick <= world.tick),
        world.weather,
        world.deadline,
        tuple(sorted(a.actor_id for a in world.actors if a.actor_id != actor_id)),
        world.task
        if world.task
        and (
            actor_id == world.task.owner
            or (actor_id == world.task.target and world.task.is_informed)
        )
        else None,
    )


def task_summary_view(view: AgentView) -> dict:
    """API 与策略共用的公开任务摘要；只依赖角色已获得的信息。"""
    task = view.task
    if task is None:
        return {"status": "not_assigned", "goal": "", "progress": {}, "outcome": None}
    stage = "confirmed" if task.confirmed else "informed" if task.is_informed else "locating"
    return {
        "task_id": task.task_id,
        "owner": task.owner,
        "target": task.target,
        "goal": "在截止前找到小汐，当面传达活动改址，确认护送或会合，并一同抵达新会场。",
        "goal_location": task.goal_location,
        "deadline": task.deadline,
        "remaining_minutes": max(0, task.deadline - view.tick),
        "status": task.status,
        "progress": {
            "stage": stage,
            "is_informed": task.is_informed,
            "confirmed": task.confirmed,
            "confirmation_mode": task.confirmation_mode,
            "informed_at": task.informed_at,
            "confirmed_at": task.confirmed_at,
        },
        "outcome": task.status if task.status != "active" else None,
        "settled_at": task.settled_at,
    }


def task_summary(world: WorldState, actor_id: str = "player") -> dict:
    return task_summary_view(observe(world, actor_id))


@dataclass(frozen=True)
class Action:
    kind: str
    actor_id: str = "player"
    target: str = ""
    item: str = ""
    minutes: int = 2


def legal_actions(view: AgentView) -> tuple[Action, ...]:
    """只依据公开地图与本人的可见信息列出动作。"""
    actions = [Action("wait", view.actor_id)]
    if view.task is not None:
        actions.extend(Action("wait", view.actor_id, minutes=t) for t in (1, 5))
    for start, end, duration in EDGES:
        if view.location in (start, end):
            actions.append(
                Action(
                    "move",
                    view.actor_id,
                    end if start == view.location else start,
                    minutes=duration,
                )
            )
    for target in view.contacts:
        actions.append(Action("ask", view.actor_id, target))
    seen = {
        o.target
        for o in view.observations
        if o.kind == "sighting" and o.evidence.observed_at == view.tick
    }
    for item in view.possessions:
        actions.extend(Action("give", view.actor_id, target, item, 0) for target in sorted(seen))
    task = view.task
    if (
        task is not None
        and task.status == "active"
        and task.owner == view.actor_id
        and task.target in seen
        and view.tick + 2 <= task.deadline
    ):
        if not task.is_informed:
            actions.append(Action("inform", view.actor_id, task.target))
        else:
            if not task.confirmed:
                actions.extend(
                    Action("confirm", view.actor_id, task.target, mode)
                    for mode in ("escort", "meet")
                )
            actions.append(Action("reschedule", view.actor_id, task.target))
    return tuple(actions)


def _draw(world: WorldState, domain: str, action: Action) -> float:
    # 域分离使新增界面/推理调用不会消耗世界随机流。
    counter = len(world.events) if world.task is None else "mission-v1"
    key = f"{world.seed}:{world.tick}:{counter}:{domain}:{action}"
    value = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big")
    return random.Random(value).random()


def _step_fixture(world: WorldState, action: Action) -> WorldState:
    view = observe(world, action.actor_id)
    if action not in legal_actions(view):
        raise ValueError("动作前置条件不满足")
    actors, ownership = world.actors, world.ownership
    records = world.observations
    tick = world.tick + action.minutes
    detail = ""
    if action.kind == "move":
        actors = tuple(
            replace(a, location=action.target) if a.actor_id == action.actor_id else a
            for a in actors
        )
        detail = f"到达{PLACES[action.target]}"
    elif action.kind == "give":
        target = world.actor(action.target)
        actor = world.actor(action.actor_id)
        if target.location != actor.location or actor.location == "transit":
            raise ValueError("交付要求双方实际同地")
        ownership = tuple(
            (item, action.target if item == action.item else owner) for item, owner in ownership
        )
        detail = f"交付物品:{action.item}"
    elif action.kind == "ask":
        target = world.actor(action.target)
        if _draw(world, "reply", action) < 0.85:
            evidence = Evidence(
                f"reply:{len(world.events)}",
                "direct" if target.actor_id == "xiaxi" else target.actor_id,
                f"reply:{len(world.events)}",
                frozenset({target.location}),
                0.9,
                tick,
                tick,
            )
            records += (Observation(evidence, target.actor_id, (action.actor_id,)),)
            detail = "收到新的位置回复"
        else:
            detail = "暂未收到回复"
    elif action.kind == "wait":
        detail = "等待"
    event = Event(
        f"event:{len(world.events)}",
        tick,
        action.kind,
        action.actor_id,
        action.target,
        detail,
        tuple(sorted({action.actor_id, action.target} & {a.actor_id for a in actors})),
    )
    return replace(
        world,
        tick=tick,
        actors=actors,
        ownership=ownership,
        observations=records,
        events=world.events + (event,),
    )


def _append_event(world: WorldState, event: Event) -> WorldState:
    return replace(
        world, events=tuple(sorted((*world.events, event), key=lambda e: (e.tick, e.event_id)))
    )


def _template_facts(world: WorldState, at: int, action: Action | None = None) -> set[str]:
    task = world.task
    if task is None:
        return set()
    facts = {"active"} if task.status == "active" else set()
    if at <= task.deadline:
        facts.add("on_time")
    if at >= task.deadline:
        facts.add("deadline_reached")
    if task.is_informed and task.informed_at <= at:
        facts.add("informed")
    elif not task.is_informed:
        facts.add("not_informed")
    if task.confirmed and task.confirmed_at <= at:
        facts.add("confirmed")
    elif not task.confirmed:
        facts.add("not_confirmed")
    owner, target = world.actor(task.owner), world.actor(task.target)
    if owner.location == target.location != "transit":
        facts.add("same_place")
    if owner.location == target.location == task.goal_location:
        facts.add("both_at_goal")
    if action and action.actor_id == task.owner and action.target == task.target:
        facts.add("owner_action")
    return facts


def _route(origin: str, destination: str, actor_id: str, depart_at: int) -> tuple[ScheduleLeg, ...]:
    """会合采用公开地图上的最短路；不读取任何角色的私密计划。"""
    queue = [(0, origin, ())]
    visited = set()
    while queue:
        distance, place, path = heapq.heappop(queue)
        if place in visited:
            continue
        visited.add(place)
        if place == destination:
            legs = []
            for start, end, duration in path:
                legs.append(ScheduleLeg(actor_id, start, end, depart_at, depart_at + duration))
                depart_at += duration
            return tuple(legs)
        for start, end, duration in EDGES:
            if place in (start, end):
                other = end if start == place else start
                heapq.heappush(
                    queue, (distance + duration, other, (*path, (place, other, duration)))
                )
    raise ValueError("任务地点不可达")


def _fire_template(
    world: WorldState, template_id: str, at: int, action: Action | None = None
) -> WorldState:
    template = next(t for t in EVENT_TEMPLATES if t.template_id == template_id)
    task = world.task
    if task is None:
        return world
    if template.trigger != (action.kind if action is not None else "settle"):
        return world
    marker = f"template:{task.task_id}:{template.template_id}"
    if template.once and marker in world.triggered_events:
        return world
    if not set(template.conditions) <= _template_facts(world, at, action):
        return world
    schedules = world.schedules
    for effect in template.effects:
        if effect == "inform":
            task = replace(task, is_informed=True, informed_at=at)
        elif effect == "hold_target":
            # 面对面交谈开始后对方暂缓原安排，避免确认过程中按旧日程自行离开。
            schedules = tuple(
                s for s in schedules if s.actor_id != task.target or s.arrive_at <= world.tick
            )
        elif effect == "confirm":
            if action is None or action.item not in {"escort", "meet"}:
                raise ValueError("确认必须指定护送或会合")
            task = replace(task, confirmed=True, confirmed_at=at, confirmation_mode=action.item)
            if action.item == "meet":
                schedules += _route(
                    world.actor(task.target).location, task.goal_location, task.target, at
                )
        elif effect in {"success", "rescheduled", "missed"}:
            task = replace(task, status=effect, settled_at=at)
        else:
            raise ValueError("事件效果未实现")
    visible = (task.owner, task.target) if task.is_informed else (task.owner,)
    event = Event(
        marker,
        at,
        "template",
        task.owner,
        task.target,
        EVENT_TEXTS[template.text_id],
        visible,
        template.template_id,
        template.text_id,
    )
    updated = replace(
        world,
        task=task,
        schedules=schedules,
        triggered_events=(*world.triggered_events, marker),
    )
    return _append_event(updated, event)


def _settle(world: WorldState) -> WorldState:
    task = world.task
    if task is None or task.status != "active":
        return world
    updated = _fire_template(world, "mission-success", world.tick)
    if updated.task.status == "active" and world.tick >= task.deadline:
        updated = _fire_template(updated, "mission-missed", task.deadline)
    return updated


def _remember_sightings(world: WorldState) -> WorldState:
    """旁人只能转述自己实际目击的历史；没有位置真值查询后门。"""
    if world.task is None:
        return world
    subject = world.actor(world.task.target)
    if subject.location == "transit":
        return world
    records = world.observations
    for viewer in world.actors:
        if viewer.actor_id not in {"roommate", "clubmate"} or viewer.location != subject.location:
            continue
        prefix = f"memory:{viewer.actor_id}:{subject.actor_id}:"
        previous = [o for o in records if o.evidence.evidence_id.startswith(prefix)]
        last = max(previous, key=lambda o: o.evidence.observed_at, default=None)
        if last is not None and last.evidence.observed_at == world.tick:
            continue
        evidence_id = f"{prefix}{world.tick}"
        origin = evidence_id
        if (
            last is not None
            and last.evidence.observed_at == world.tick - 1
            and last.evidence.support == {subject.location}
        ):
            origin = last.evidence.origin_id
            records = tuple(o for o in records if o is not last)
        evidence = Evidence(
            evidence_id,
            viewer.actor_id,
            origin,
            frozenset({subject.location}),
            0.9,
            world.tick,
            world.tick,
        )
        records += (Observation(evidence, subject.actor_id, (viewer.actor_id,)),)
    return replace(world, observations=records)


def _advance_to(world: WorldState, tick: int) -> WorldState:
    """按每个游戏分钟依次处理到达、出发、观察与截止，不能跳过截止结算。"""
    if tick < world.tick:
        raise ValueError("时间不能倒退")
    for current in range(world.tick, tick + 1):
        world = replace(world, tick=current)
        for phase in ("arrival", "departure"):
            for leg in sorted(world.schedules, key=lambda s: s.leg_id):
                at = leg.arrive_at if phase == "arrival" else leg.depart_at
                marker = f"schedule:{leg.leg_id}:{phase}"
                if at != current or marker in world.triggered_events:
                    continue
                location = leg.destination if phase == "arrival" else "transit"
                actors = tuple(
                    replace(a, location=location) if a.actor_id == leg.actor_id else a
                    for a in world.actors
                )
                detail = f"到达{PLACES[leg.destination]}" if phase == "arrival" else "出发，在途"
                world = replace(
                    world, actors=actors, triggered_events=(*world.triggered_events, marker)
                )
                world = _append_event(
                    world, Event(marker, current, phase, leg.actor_id, "", detail, (leg.actor_id,))
                )
        world = _remember_sightings(world)
        world = _settle(world)
    return world


def _mission_reply(world: WorldState, before: WorldState, action: Action) -> tuple[WorldState, str]:
    contact = world.actor(action.target)
    subject = world.actor(world.task.target)
    busy = contact.location == "transit" or any(
        p.actor_id == contact.actor_id and p.start <= world.tick < p.end for p in world.busy_periods
    )
    if busy or _draw(before, "reply", action) >= 0.85:
        return world, "询问小汐在哪：暂未收到回复（可能在忙碌或未查看消息）"
    reply_id = f"reply:{action.actor_id}:{action.target}:{world.tick}:{len(world.events)}"
    if contact.actor_id == subject.actor_id:
        evidence = Evidence(
            reply_id,
            "direct",
            reply_id,
            frozenset({subject.location}),
            0.9,
            world.tick,
            world.tick,
        )
    else:
        reports = observe(world, contact.actor_id).evidence_for(subject.actor_id)
        if not reports:
            return world, "询问小汐在哪：对方目前也没有线索"
        last = max(reports, key=lambda e: (e.observed_at, e.received_at, e.evidence_id))
        evidence = Evidence(
            reply_id,
            contact.actor_id,
            last.origin_id,
            last.support,
            min(0.9, last.reliability),
            last.observed_at,
            world.tick,
        )
    observation = Observation(evidence, subject.actor_id, (action.actor_id,))
    return replace(
        world, observations=(*world.observations, observation)
    ), "收到关于小汐位置的回复（保留目击时间）"


def step(world: WorldState, action: Action) -> WorldState:
    if type(action.minutes) is not int or action.minutes < 0:
        raise ValueError("动作耗时必须是非负整数")
    if world.task is None:
        return _step_fixture(world, action)
    view = observe(world, action.actor_id)
    if action not in legal_actions(view):
        raise ValueError("动作前置条件不满足")
    finish = world.tick + action.minutes
    updated = world
    detail = "等待"
    if action.kind == "move":
        movers = [action.actor_id]
        task = world.task
        if (
            action.actor_id == task.owner
            and task.status == "active"
            and task.confirmed
            and task.confirmation_mode == "escort"
            and world.actor(task.target).location == view.location
        ):
            movers.append(task.target)
        schedules = tuple(
            s for s in world.schedules if s.actor_id not in movers or s.arrive_at <= world.tick
        )
        schedules += tuple(
            ScheduleLeg(a, view.location, action.target, world.tick, finish) for a in movers
        )
        updated = replace(world, schedules=schedules)
        detail = f"到达{PLACES[action.target]}" + ("；小汐同行" if len(movers) > 1 else "")
    elif action.kind == "give":
        updated = replace(
            world,
            ownership=tuple(
                (item, action.target if item == action.item else owner)
                for item, owner in world.ownership
            ),
        )
        detail = f"交付物品:{action.item}"
    elif action.kind in {"inform", "confirm", "reschedule"}:
        template_id = {
            "inform": "venue-informed",
            "confirm": "appointment-confirmed",
            "reschedule": "mission-rescheduled",
        }[action.kind]
        updated = _fire_template(world, template_id, finish, action)
        if updated is world:
            raise ValueError("事件前置条件不满足或已经触发")
        detail = EVENT_TEXTS[
            next(t.text_id for t in EVENT_TEMPLATES if t.template_id == template_id)
        ]
        if action.kind == "confirm":
            detail += "护送同行" if action.item == "escort" else "按公开地图最短路在会场会合"
    updated = _advance_to(updated, finish)
    if action.kind == "ask":
        updated, detail = _mission_reply(updated, world, action)
    visible = tuple(sorted({action.actor_id, action.target} & {a.actor_id for a in world.actors}))
    event = Event(
        f"action:{len(updated.events)}:{action.actor_id}:{finish}",
        finish,
        action.kind,
        action.actor_id,
        action.target,
        detail,
        visible,
    )
    return _settle(_append_event(updated, event))


def scenario(name: str = "conflict", seed: int = 17) -> WorldState:
    """少量机制夹具；概率和可靠度都是显式设计值。"""
    if name == "mission":
        return _mission(seed)
    if name == "challenge":
        return _challenge(seed)
    if name not in ("conflict", "duplicate", "umbrella"):
        raise ValueError("未知场景")
    actors = (
        Actor("player", "teaching"),
        Actor("xiaxi", "club"),
        Actor("roommate", "canteen"),
        Actor("clubmate", "library"),
    )
    records = [
        Observation(
            Evidence("old-photo", "roommate", "photo-1", frozenset({"library"}), 0.85, 0, 19),
            "xiaxi",
            ("player",),
        ),
        Observation(
            Evidence("club-report", "clubmate", "report-1", frozenset({"club"}), 0.8, 19, 20),
            "xiaxi",
            ("player",),
        ),
    ]
    if name == "duplicate":
        records.extend(
            Observation(
                Evidence(
                    f"forward-{i}", f"forwarder-{i}", "photo-1", frozenset({"library"}), 0.85, 0, 20
                ),
                "xiaxi",
                ("player",),
            )
            for i in range(10)
        )
    if name == "umbrella":
        actors = tuple(
            replace(a, location="teaching") if a.actor_id == "xiaxi" else a for a in actors
        )
    return WorldState(seed, 20, actors, (("umbrella", "player"),), tuple(records))


def _mission(seed: int) -> WorldState:
    """真正推进日程的短任务；历史线索在其观察时刻确有依据。"""
    shift = seed % 3
    schedules = (
        ScheduleLeg("xiaxi", "library", "club", 8, 14),
        ScheduleLeg("xiaxi", "club", "walkway", 30 + shift, 34 + shift),
        ScheduleLeg("xiaxi", "walkway", "canteen", 38 + shift, 43 + shift),
        ScheduleLeg("xiaxi", "canteen", "venue", 49 + shift, 57 + shift),
        ScheduleLeg("roommate", "library", "teaching", 4, 9),
        ScheduleLeg("roommate", "teaching", "walkway", 18, 22),
        ScheduleLeg("roommate", "walkway", "canteen", 30, 35),
        ScheduleLeg("roommate", "canteen", "venue", 45, 53),
        ScheduleLeg("clubmate", "club", "library", 21, 27),
        ScheduleLeg("clubmate", "library", "teaching", 35, 40),
        ScheduleLeg("clubmate", "teaching", "walkway", 45, 49),
        ScheduleLeg("clubmate", "walkway", "venue", 52, 59),
    )
    records = (
        Observation(
            Evidence("old-photo", "roommate", "photo-1", {"library"}, 0.85, 0, 19),
            "xiaxi",
            ("player",),
        ),
        Observation(
            Evidence("club-report", "clubmate", "report-1", {"club"}, 0.8, 19, 20),
            "xiaxi",
            ("player",),
        ),
    )
    initial = WorldState(
        seed,
        0,
        (
            Actor("player", "teaching"),
            Actor("xiaxi", "library"),
            Actor("roommate", "library"),
            Actor("clubmate", "club"),
        ),
        (("umbrella", "player"),),
        records,
        task=Task(),
        schedules=schedules,
        busy_periods=(BusyPeriod("xiaxi", 20, 27), BusyPeriod("clubmate", 40, 44)),
    )
    return _advance_to(initial, 20)


def _challenge_rng(seed: int, domain: str) -> random.Random:
    """布局、日程、消息与环境各用独立随机域，避免添加消息改变人物路线。"""
    digest = hashlib.sha256(f"challenge-v1:{seed}:{domain}".encode()).digest()
    return random.Random(int.from_bytes(digest[:16], "big"))


def _challenge_history(
    actor_id: str, destination: str, arrive_by: int, rng: random.Random
) -> tuple[str, tuple[ScheduleLeg, ...]]:
    """从可及时到达的真实起点出发，在指定历史时刻前到达目击地点。"""
    routes = {place: _route(place, destination, actor_id, 0) for place in PLACES}
    eligible = [
        place for place, route in routes.items() if not route or route[-1].arrive_at <= arrive_by
    ]
    origin = rng.choice(eligible)
    route = routes[origin]
    duration = route[-1].arrive_at if route else 0
    arrive_at = rng.randint(duration, arrive_by)
    return origin, _route(origin, destination, actor_id, arrive_at - duration)


def _challenge_walk(
    actor_id: str, origin: str, depart_at: int, horizon: int, rng: random.Random
) -> tuple[ScheduleLeg, ...]:
    """六节点地图上的连续日程，优先避免立即折返；每一段都是真实地图边。"""
    legs = []
    place, previous = origin, None
    while depart_at <= horizon:
        neighbors = [
            (end if start == place else start, duration)
            for start, end, duration in EDGES
            if place in (start, end)
        ]
        forward = [(other, duration) for other, duration in neighbors if other != previous]
        destination, duration = rng.choice(forward or neighbors)
        arrive_at = depart_at + duration
        legs.append(ScheduleLeg(actor_id, place, destination, depart_at, arrive_at))
        previous, place = place, destination
        depart_at = arrive_at + rng.randint(1, 8)
    return tuple(legs)


def _historical_location(origin: str, schedules: tuple[ScheduleLeg, ...], at: int) -> str:
    """仅供场景生成核对历史；不会投影给角色或用来回答玩家询问。"""
    location = origin
    for leg in sorted(schedules, key=lambda s: s.depart_at):
        if at < leg.depart_at:
            break
        if at < leg.arrive_at:
            return "transit"
        location = leg.destination
    return location


def _challenge(seed: int) -> WorldState:
    """可复现的动态挑战：先生成真实历史，再从历史抽样线索。"""
    start = 20
    layout_rng = _challenge_rng(seed, "layout")
    target_rng = _challenge_rng(seed, "xiaxi-schedule")
    evidence_rng = _challenge_rng(seed, "reports")
    environment_rng = _challenge_rng(seed, "environment")
    player_location = layout_rng.choice(tuple(PLACES))
    target_location = layout_rng.choice(tuple(PLACES))
    to_target = _route(player_location, target_location, "player", start)
    find_cost = to_target[-1].arrive_at - start if to_target else 0
    to_venue = _route(target_location, "venue", "xiaxi", 0)
    arrival_cost = to_venue[-1].arrive_at if to_venue else 0
    # 只保证存在合法路线：真值最短路找人 + 两次交谈 + 抵达会场。
    # 玩家看到的仍是历史线索；等待、求证、误走路线都可能耗尽这份预算。
    deadline = start + find_cost + 4 + arrival_cost + environment_rng.choice((0, 2, 5, 8, 12, 18))
    horizon = deadline + 20
    target_origin, target_history = _challenge_history("xiaxi", target_location, start, target_rng)
    target_schedules = target_history + _challenge_walk(
        "xiaxi",
        target_location,
        start + find_cost + target_rng.randint(1, 6),
        horizon,
        target_rng,
    )
    stationary = [
        at
        for at in range(start)
        if _historical_location(target_origin, target_history, at) != "transit"
    ]
    midpoint = max(1, len(stationary) // 2)
    observed_times = (
        evidence_rng.choice(stationary[:midpoint]),
        evidence_rng.choice(stationary[midpoint:] or stationary),
    )
    actors = [Actor("player", player_location), Actor("xiaxi", target_origin)]
    schedules = target_schedules
    records = []
    for actor_id, observed_at in zip(("roommate", "clubmate"), observed_times, strict=True):
        seen_place = _historical_location(target_origin, target_history, observed_at)
        contact_rng = _challenge_rng(seed, f"{actor_id}-schedule")
        origin, history = _challenge_history(actor_id, seen_place, observed_at, contact_rng)
        schedules += history + _challenge_walk(
            actor_id,
            seen_place,
            observed_at + contact_rng.randint(1, 4),
            horizon,
            contact_rng,
        )
        actors.append(Actor(actor_id, origin))
        evidence = Evidence(
            f"initial-report:{actor_id}",
            actor_id,
            f"witness:{actor_id}:{observed_at}",
            frozenset({seen_place}),
            0.9,
            observed_at,
            evidence_rng.randint(observed_at, start),
        )
        records.append(Observation(evidence, "xiaxi", ("player",)))
    if evidence_rng.random() < 0.4:
        observed_at = evidence_rng.choice(stationary)
        seen_place = _historical_location(target_origin, target_history, observed_at)
        records.append(
            Observation(
                Evidence(
                    "initial-camera",
                    "camera",
                    f"camera:{observed_at}",
                    frozenset({seen_place}),
                    0.95,
                    observed_at,
                    evidence_rng.randint(observed_at, start),
                ),
                "xiaxi",
                ("player",),
            )
        )
    busy_periods = []
    for actor_id in ("xiaxi", "roommate", "clubmate"):
        busy_start = environment_rng.randint(start - 5, start + 9)
        busy_periods.append(
            BusyPeriod(actor_id, busy_start, busy_start + environment_rng.randint(2, 9))
        )
        busy_start = environment_rng.randint(start + 10, max(start + 10, deadline))
        busy_periods.append(
            BusyPeriod(actor_id, busy_start, busy_start + environment_rng.randint(2, 8))
        )
    initial = WorldState(
        seed,
        0,
        tuple(actors),
        (("umbrella", "player"),),
        tuple(records),
        weather=environment_rng.choice(("clear", "rain", "showers")),
        deadline=deadline,
        task=Task(deadline=deadline),
        schedules=schedules,
        busy_periods=tuple(busy_periods),
    )
    return _advance_to(initial, start)
