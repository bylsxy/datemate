"""机制用事件模板；条件和效果由世界执行器解释，文本与状态转换分离。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class EventTemplate:
    template_id: str
    trigger: str
    conditions: tuple[str, ...]
    effects: tuple[str, ...]
    text_id: str
    once: bool = True


EVENT_TEMPLATES = (
    EventTemplate(
        "venue-informed",
        "inform",
        ("active", "owner_action", "same_place", "on_time", "not_informed"),
        ("inform", "hold_target"),
        "mission.venue_informed",
    ),
    EventTemplate(
        "appointment-confirmed",
        "confirm",
        ("active", "owner_action", "same_place", "on_time", "informed", "not_confirmed"),
        ("confirm",),
        "mission.appointment_confirmed",
    ),
    EventTemplate(
        "mission-success",
        "settle",
        ("active", "informed", "confirmed", "both_at_goal", "on_time"),
        ("success",),
        "mission.success",
    ),
    EventTemplate(
        "mission-rescheduled",
        "reschedule",
        ("active", "owner_action", "same_place", "on_time", "informed"),
        ("rescheduled",),
        "mission.rescheduled",
    ),
    EventTemplate(
        "mission-missed",
        "settle",
        ("active", "deadline_reached"),
        ("missed",),
        "mission.missed",
    ),
)

EVENT_TEXTS = {
    "mission.venue_informed": "已当面告知小汐：活动改到会场举行。",
    "mission.appointment_confirmed": "已确认前往新会场的安排。",
    "mission.success": "两人在截止前抵达新会场，任务完成。",
    "mission.rescheduled": "两人当面同意另约时间；本次按时到场目标未完成。",
    "mission.missed": "约定时间已到，未能完成传达、确认并一同到场。",
}
