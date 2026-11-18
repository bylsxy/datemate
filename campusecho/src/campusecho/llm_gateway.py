"""CampusEcho 的 OpenAI 兼容 LLM 网关与搜索辅助接口。

模块只依赖 Python 标准库。网络、时钟和持久化均可注入，因此测试不会访问真实端点。
LLM 输出只作为对已验证规则的补充意见；动作合法性、路径和奖励由本地确定性逻辑裁决。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, replace
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from math import isfinite
from os import environ
from pathlib import Path
from statistics import median
from threading import Lock
from time import monotonic, perf_counter
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .world import Action, AgentView, legal_actions, observe, scenario, step

DEFAULT_DEEPSEEK_MODEL = "deepseek-flash"
DEFAULT_SCORE_PATH = Path(__file__).resolve().parents[2] / "data" / "model_scores.json"
DEFAULT_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "campusecho-models.json"
DEFAULT_MAX_RESPONSE_BYTES = 1_000_000


class GatewayError(RuntimeError):
    """可安全展示给调用方的网关错误，消息不含密钥或完整响应体。"""


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


@dataclass(frozen=True)
class UrllibTransport:
    """最小 urllib 适配器；限制读取大小并把异常归一化为安全错误。"""

    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
    ) -> tuple[int, Mapping[str, str], bytes]:
        request = Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = response.read(self.max_response_bytes + 1)
                if len(payload) > self.max_response_bytes:
                    raise GatewayError("HTTP 响应超过大小上限")
                return response.status, dict(response.headers.items()), payload
        except HTTPError as exc:
            # HTTP 错误体可能回显凭据，只保留状态码。
            raise GatewayError(f"HTTP 状态码 {exc.code}") from None
        except (TimeoutError, URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise GatewayError(f"网络请求失败：{type(reason).__name__}") from None


@dataclass(frozen=True)
class GatewayConfig:
    base_url: str = ""
    env_key: str = "AXONHUB_API_KEY"
    private_config: Path | None = None
    timeout: float = 8.0
    retries: int = 2
    backoff: float = 0.25
    cache_path: Path = DEFAULT_CACHE_PATH
    score_path: Path = DEFAULT_SCORE_PATH
    deepseek_model: str = DEFAULT_DEEPSEEK_MODEL

    def __post_init__(self) -> None:
        if not isfinite(self.timeout) or self.timeout <= 0:
            raise ValueError("timeout 必须是有限正数")
        if self.retries < 0:
            raise ValueError("retries 不能为负")
        if not isfinite(self.backoff) or self.backoff < 0:
            raise ValueError("backoff 必须是非负有限数")


@dataclass(frozen=True)
class ModelInfo:
    id: str
    owned_by: str = ""
    created: int | None = None


@dataclass(frozen=True)
class ModelSelection:
    model: str
    score: float
    score_version: str
    status: str
    available_models: tuple[str, ...] = ()


@dataclass(frozen=True)
class UsageRecord:
    cache_key: str
    request_id: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    elapsed_seconds: float
    cost: Decimal | None
    status: str
    model: str

    def as_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["cost"] = str(self.cost) if self.cost is not None else None
        return result


@dataclass(frozen=True)
class ChatResult:
    status: str
    content: str | None
    model: str | None
    usage: UsageRecord
    error: str | None = None


@dataclass(frozen=True)
class ActionAdvice:
    status: str
    action: Action | None
    legal: bool
    reason: str
    source: str


@dataclass(frozen=True)
class PathReward:
    status: str
    reward: float | None
    verified: bool
    reason: str
    steps: int = 0


@dataclass(frozen=True)
class VerifiedPathExplanation:
    status: str
    explanation: str | None
    evidence_ids: tuple[str, ...]
    action_count: int


@dataclass(frozen=True)
class EndpointResult:
    endpoint: str
    status: str
    samples_ms: tuple[float, ...]
    median_ms: float | None
    models: tuple[str, ...]
    error: str | None = None


@dataclass(frozen=True)
class EndpointBenchmark:
    results: tuple[EndpointResult, ...]
    candidates: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SearchSuggestion:
    status: str
    query_terms: tuple[str, ...]
    reason: str
    source: str


@dataclass(frozen=True)
class KGActionCandidate:
    """知识图谱搜索中的一个候选动作；不包含标准答案或目标实体真值。"""

    action_id: str
    relation: str
    target_label: str


@dataclass(frozen=True)
class KGActionScore:
    action_id: str
    reward: float
    legal: bool
    reason: str


@dataclass(frozen=True)
class KGActionEvaluation:
    status: str
    scores: tuple[KGActionScore, ...]
    error: str | None = None


@dataclass(frozen=True)
class KGPathExplanation:
    status: str
    explanation: str | None
    evidence_ids: tuple[str, ...]
    error: str | None = None


@dataclass
class _CacheEntry:
    content: str
    model: str
    created_at: float


def _safe_error(message: str, secret: str = "") -> str:
    """错误经过单行化与脱敏，避免密钥进入日志、响应或测试失败信息。"""
    cleaned = " ".join(str(message).split())[:240]
    return cleaned.replace(secret, "[REDACTED]") if secret else cleaned


def _nonempty_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} 必须是非空字符串")
    return value.strip()


def _normalize_kg_candidates(
    candidates: Sequence[KGActionCandidate | Mapping[str, Any]],
) -> tuple[KGActionCandidate, ...]:
    if isinstance(candidates, (str, bytes)) or not isinstance(candidates, Sequence):
        raise TypeError("候选动作必须是序列")
    normalized: list[KGActionCandidate] = []
    seen: set[str] = set()
    for raw in candidates:
        if isinstance(raw, KGActionCandidate):
            candidate = raw
        elif isinstance(raw, Mapping):
            if set(raw) != {"action_id", "relation", "target_label"}:
                raise ValueError("候选动作只能包含 action_id、relation、target_label")
            candidate = KGActionCandidate(
                _nonempty_text(raw.get("action_id"), "action_id"),
                _nonempty_text(raw.get("relation"), "relation"),
                _nonempty_text(raw.get("target_label"), "target_label"),
            )
        else:
            raise TypeError("候选动作格式无效")
        action_id = _nonempty_text(candidate.action_id, "action_id")
        relation = _nonempty_text(candidate.relation, "relation")
        target_label = _nonempty_text(candidate.target_label, "target_label")
        if action_id in seen:
            raise ValueError("action_id 不能重复")
        seen.add(action_id)
        normalized.append(KGActionCandidate(action_id, relation, target_label))
    if not normalized:
        raise ValueError("候选动作不能为空")
    return tuple(normalized)


def _normalize_kg_path(
    path_entities: Sequence[str], path_relations: Sequence[str]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if isinstance(path_entities, (str, bytes)) or not isinstance(path_entities, Sequence):
        raise TypeError("当前路径实体必须是序列")
    if isinstance(path_relations, (str, bytes)) or not isinstance(path_relations, Sequence):
        raise TypeError("当前路径关系必须是序列")
    entities = tuple(_nonempty_text(item, "路径实体") for item in path_entities)
    relations = tuple(_nonempty_text(item, "路径关系") for item in path_relations)
    if not entities:
        raise ValueError("当前路径实体不能为空")
    if len(relations) != len(entities) - 1:
        raise ValueError("当前路径关系数必须等于实体数减一")
    return entities, relations


def _normalize_path_triples(
    path_triples: Sequence[Sequence[str]],
) -> tuple[tuple[str, str, str], ...]:
    if isinstance(path_triples, (str, bytes)) or not isinstance(path_triples, Sequence):
        raise TypeError("路径三元组必须是序列")
    triples: list[tuple[str, str, str]] = []
    previous: str | None = None
    for raw in path_triples:
        if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence) or len(raw) != 3:
            raise ValueError("每个路径项必须恰好包含三个字符串")
        head, relation, tail = (_nonempty_text(item, "路径三元组字段") for item in raw)
        if previous is not None and head != previous:
            raise ValueError("路径三元组必须首尾相接")
        triples.append((head, relation, tail))
        previous = tail
    if not triples:
        raise ValueError("路径三元组不能为空")
    return tuple(triples)


def kg_source_evidence_id(title: str) -> str:
    """来源标题到稳定证据 ID 的映射；接口不要求调用方另造 ID。"""
    normalized = _nonempty_text(title, "来源标题")
    digest = sha256(normalized.encode("utf-8")).hexdigest()[:24]
    return f"source:{digest}"


def _normalize_source_titles(source_titles: Sequence[str]) -> tuple[tuple[str, str], ...]:
    if isinstance(source_titles, (str, bytes)) or not isinstance(source_titles, Sequence):
        raise TypeError("来源标题必须是序列")
    result: list[tuple[str, str]] = []
    seen_titles: set[str] = set()
    seen_ids: set[str] = set()
    for raw in source_titles:
        title = _nonempty_text(raw, "来源标题")
        evidence_id = kg_source_evidence_id(title)
        if title in seen_titles or evidence_id in seen_ids:
            raise ValueError("来源标题不能重复")
        seen_titles.add(title)
        seen_ids.add(evidence_id)
        result.append((evidence_id, title))
    if not result:
        raise ValueError("来源标题不能为空")
    return tuple(result)


def _normalized_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("端点必须是无凭据的 http(s) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("端点不能包含凭据、查询参数或片段")
    return value.rstrip("/")


def _read_private_config(path: Path | None) -> tuple[str, str]:
    if path is None or not path.is_file():
        return "", ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "", ""
    if not isinstance(data, Mapping):
        return "", ""
    base_url = data.get("base_url", "")
    api_key = data.get("api_key", "")
    return (
        base_url if isinstance(base_url, str) else "",
        api_key if isinstance(api_key, str) else "",
    )


def _resolve_credentials(config: GatewayConfig) -> tuple[str, str]:
    file_url, file_key = _read_private_config(config.private_config)
    base_url = config.base_url or environ.get("AXONHUB_BASE_URL", "") or file_url
    api_key = environ.get(config.env_key, "") or file_key
    return base_url.strip(), api_key.strip()


def _json_object(payload: bytes) -> Mapping[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GatewayError("端点返回了无效 JSON") from exc
    if not isinstance(value, Mapping):
        raise GatewayError("端点 JSON 顶层必须是对象")
    return value


def _extract_models(payload: Mapping[str, Any]) -> tuple[ModelInfo, ...]:
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise GatewayError("模型列表缺少 data 数组")
    result: list[ModelInfo] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        model_id = row.get("id")
        if not isinstance(model_id, str) or not model_id.strip() or model_id in seen:
            continue
        owned_by = row.get("owned_by", "")
        created = row.get("created")
        result.append(
            ModelInfo(
                model_id.strip(),
                owned_by if isinstance(owned_by, str) else "",
                created if isinstance(created, int) and not isinstance(created, bool) else None,
            )
        )
        seen.add(model_id)
    return tuple(result)


def _load_scores(path: Path) -> tuple[str, Mapping[str, Mapping[str, Any]]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GatewayError("评分表不可读") from exc
    if not isinstance(payload, Mapping) or payload.get("schema_version") != 1:
        raise GatewayError("评分表 schema_version 不受支持")
    version = payload.get("score_version")
    models = payload.get("models")
    if not isinstance(version, str) or not version or not isinstance(models, Mapping):
        raise GatewayError("评分表缺少 score_version 或 models")
    return version, models


def select_model(
    available: Iterable[str],
    *,
    score_path: Path = DEFAULT_SCORE_PATH,
    fallback: str = DEFAULT_DEEPSEEK_MODEL,
    allow_offline_fallback: bool = False,
) -> ModelSelection:
    """只从实时名单与精确评分表交集选择最高分；未知模型不猜分。"""
    version, scores = _load_scores(score_path)
    live = tuple(dict.fromkeys(item for item in available if isinstance(item, str) and item))
    candidates: list[tuple[float, str]] = []
    for model in live:
        row = scores.get(model)
        if not isinstance(row, Mapping) or row.get("verified") is not True:
            continue
        score = row.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            continue
        numeric = float(score)
        if isfinite(numeric):
            candidates.append((numeric, model))
    if candidates:
        score, model = max(candidates, key=lambda item: (item[0], item[1]))
        return ModelSelection(model, score, version, "online", live)
    if fallback and (fallback in live or allow_offline_fallback):
        row = scores.get(fallback)
        score = row.get("score") if isinstance(row, Mapping) else None
        numeric = float(score) if isinstance(score, (int, float)) else 0.0
        return ModelSelection(fallback, numeric, version, "deepseek", live)
    return ModelSelection("", 0.0, version, "unavailable", live)


def _validate_action(value: Mapping[str, Any], view: AgentView) -> Action:
    allowed = {"kind", "actor_id", "target", "item", "minutes"}
    if set(value) - allowed:
        raise ValueError("动作包含未知字段")
    kind = value.get("kind")
    actor_id = value.get("actor_id", view.actor_id)
    target = value.get("target", "")
    item = value.get("item", "")
    minutes = value.get("minutes", 2)
    if not all(isinstance(v, str) for v in (kind, actor_id, target, item)):
        raise ValueError("动作文本字段类型错误")
    if isinstance(minutes, bool) or not isinstance(minutes, int) or not 0 <= minutes <= 60:
        raise ValueError("动作 minutes 必须是 0 到 60 的整数")
    action = Action(kind, actor_id, target, item, minutes)
    if action not in legal_actions(view):
        raise ValueError("动作不合法")
    return action


def validate_action_advice(
    payload: str | bytes | Mapping[str, Any] | None, view: AgentView
) -> ActionAdvice:
    """严格校验 LLM 动作意见；任何坏 JSON 或越界值都降级为无建议。"""
    try:
        if isinstance(payload, Mapping):
            data = payload
        elif isinstance(payload, (str, bytes)):
            data = json.loads(payload)
        else:
            raise TypeError("空响应")
        if not isinstance(data, Mapping) or set(data) != {"action", "reason"}:
            raise ValueError("响应必须是仅含 action 和 reason 的对象")
        action_data = data["action"]
        reason = data["reason"]
        if not isinstance(action_data, Mapping) or not isinstance(reason, str) or not reason.strip():
            raise ValueError("action 或 reason 格式错误")
        action = _validate_action(action_data, view)
        return ActionAdvice("ok", action, True, reason.strip()[:500], "llm")
    except (json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return ActionAdvice("degraded", None, False, _safe_error(str(exc)), "fallback")


def path_reward(view: AgentView, actions: Sequence[Action]) -> PathReward:
    """逐步执行动作序列，只有整条路径合法时返回确定性奖励。"""
    world = scenario("mission", seed=17) if view.task is not None else scenario("umbrella")
    current = observe(world, view.actor_id)
    if current != view:
        return PathReward("invalid", None, False, "视图不是可重放的初始世界快照")
    total = 0.0
    for index, action in enumerate(actions):
        if not isinstance(action, Action) or action not in legal_actions(current):
            return PathReward("invalid", None, False, f"第 {index + 1} 步动作不合法", index)
        try:
            world = step(world, action)
        except ValueError as exc:
            return PathReward("invalid", None, False, _safe_error(str(exc)), index)
        current = observe(world, view.actor_id)
        total += 2.0 if action.kind == "ask" else 1.0
        total += 8.0 if action.kind in {"inform", "confirm"} else 0.0
        total += 20.0 if action.kind == "reschedule" else 0.0
    if current.task is not None:
        total += {"success": 50.0, "rescheduled": 5.0, "missed": -50.0}.get(
            current.task.status, 0.0
        )
    return PathReward("ok", total, True, "整条路径已由本地世界执行器验证", len(actions))


def validate_path_explanation(
    payload: str | bytes | Mapping[str, Any] | None,
    view: AgentView,
    actions: Sequence[Action],
) -> VerifiedPathExplanation:
    """解释必须引用输入中真实存在的证据 ID，且整条路径已通过本地验证。"""
    reward = path_reward(view, actions)
    if not reward.verified:
        return VerifiedPathExplanation("degraded", None, (), len(actions))
    try:
        data = json.loads(payload) if isinstance(payload, (str, bytes)) else payload
        if not isinstance(data, Mapping) or set(data) != {"explanation", "evidence_ids"}:
            raise ValueError("解释 JSON 字段不匹配")
        explanation = data["explanation"]
        ids = data["evidence_ids"]
        if not isinstance(explanation, str) or not explanation.strip() or not isinstance(ids, list):
            raise ValueError("解释或证据字段格式错误")
        if not all(isinstance(item, str) and item for item in ids) or len(ids) != len(set(ids)):
            raise ValueError("证据 ID 必须是非空且不重复的字符串")
        visible = {
            record.evidence.evidence_id
            for record in view.observations
            if record.evidence.received_at <= view.tick and record.evidence.observed_at <= view.tick
        }
        if not set(ids) <= visible:
            raise ValueError("解释引用了不可见或未知证据")
        return VerifiedPathExplanation("ok", explanation.strip()[:1000], tuple(ids), len(actions))
    except (json.JSONDecodeError, TypeError, ValueError):
        return VerifiedPathExplanation("degraded", None, (), len(actions))


def validate_kg_action_evaluation(
    payload: str | bytes | Mapping[str, Any] | None,
    candidates: Sequence[KGActionCandidate | Mapping[str, Any]],
) -> KGActionEvaluation:
    """严格校验批量动作评分；任一缺项、重复或越界都会使整批失效。"""
    try:
        normalized = _normalize_kg_candidates(candidates)
        if isinstance(payload, Mapping):
            data = payload
        elif isinstance(payload, (str, bytes)):
            if not payload.strip():
                raise ValueError("空响应")
            data = json.loads(payload)
        else:
            raise TypeError("空响应")
        if not isinstance(data, Mapping) or set(data) != {"scores"}:
            raise ValueError("响应必须只包含 scores")
        rows = data["scores"]
        if not isinstance(rows, list) or not rows:
            raise ValueError("scores 必须是非空数组")
        expected = {candidate.action_id for candidate in normalized}
        seen: set[str] = set()
        parsed: dict[str, KGActionScore] = {}
        for row in rows:
            if not isinstance(row, Mapping) or set(row) != {
                "action_id",
                "reward",
                "legal",
                "reason",
            }:
                raise ValueError("评分项字段不匹配")
            action_id = _nonempty_text(row["action_id"], "action_id")
            if action_id not in expected or action_id in seen:
                raise ValueError("评分项包含未知或重复 action_id")
            seen.add(action_id)
            reward = row["reward"]
            legal = row["legal"]
            reason = row["reason"]
            if (
                isinstance(reward, bool)
                or not isinstance(reward, (int, float))
                or not isfinite(float(reward))
                or not -1.0 <= float(reward) <= 1.0
            ):
                raise ValueError("reward 必须是 [-1, 1] 内的有限数")
            if not isinstance(legal, bool):
                raise TypeError("legal 必须是 bool")
            reason = _nonempty_text(reason, "reason")
            parsed[action_id] = KGActionScore(
                action_id, float(reward), legal, reason[:500]
            )
        if seen != expected:
            raise ValueError("评分项必须覆盖全部候选动作")
        return KGActionEvaluation(
            "ok", tuple(parsed[candidate.action_id] for candidate in normalized)
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return KGActionEvaluation("degraded", (), _safe_error(str(exc)))


def validate_kg_path_explanation(
    payload: str | bytes | Mapping[str, Any] | None,
    path_triples: Sequence[Sequence[str]],
    source_titles: Sequence[str],
) -> KGPathExplanation:
    """解释只可引用由来源标题派生的证据 ID；路径必须首尾相接。"""
    try:
        triples = _normalize_path_triples(path_triples)
        sources = _normalize_source_titles(source_titles)
        allowed_ids = {evidence_id for evidence_id, _ in sources}
        if isinstance(payload, Mapping):
            data = payload
        elif isinstance(payload, (str, bytes)):
            if not payload.strip():
                raise ValueError("空响应")
            data = json.loads(payload)
        else:
            raise TypeError("空响应")
        if not isinstance(data, Mapping) or set(data) != {"explanation", "evidence_ids"}:
            raise ValueError("响应必须只包含 explanation 和 evidence_ids")
        explanation = _nonempty_text(data["explanation"], "explanation")
        evidence_ids = data["evidence_ids"]
        if not isinstance(evidence_ids, list) or not evidence_ids:
            raise ValueError("evidence_ids 必须是非空数组")
        if (
            not all(isinstance(item, str) and item in allowed_ids for item in evidence_ids)
            or len(evidence_ids) != len(set(evidence_ids))
        ):
            raise ValueError("evidence_ids 含未知或重复引用")
        # 解释输入仅用于校验路径结构，LLM 无权扩展或改写答案实体。
        if not triples:
            raise ValueError("路径三元组不能为空")
        return KGPathExplanation("ok", explanation[:1000], tuple(evidence_ids))
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return KGPathExplanation("degraded", None, (), _safe_error(str(exc)))


class LLMGateway:
    """可注入传输和时钟的网关；模型刷新在线程中执行，失败回退缓存。"""

    def __init__(
        self,
        config: GatewayConfig | None = None,
        *,
        transport: Transport | None = None,
        clock: Callable[[], float] = monotonic,
        timer: Callable[[], float] = perf_counter,
        sleeper: Callable[[float], None] | None = None,
        executor: ThreadPoolExecutor | None = None,
    ) -> None:
        self.config = config or GatewayConfig()
        self.transport = transport or UrllibTransport()
        self._clock = clock
        self._timer = timer
        self._sleep = sleeper
        self._executor = executor
        self._lock = Lock()
        self._models: tuple[ModelInfo, ...] = ()
        self._selection = ModelSelection("", 0.0, "", "unavailable")
        self._refresh_future: Future[ModelSelection] | None = None
        self._cache: dict[str, _CacheEntry] = {}
        self._usage: list[UsageRecord] = []
        self._load_cache()

    @property
    def usage_records(self) -> tuple[UsageRecord, ...]:
        with self._lock:
            return tuple(self._usage)

    @property
    def selection(self) -> ModelSelection:
        with self._lock:
            return self._selection

    def _headers(self) -> dict[str, str]:
        _, api_key = _resolve_credentials(self.config)
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def _request_json(
        self, method: str, path: str, payload: Mapping[str, Any] | None = None
    ) -> Mapping[str, Any]:
        base_url, api_key = _resolve_credentials(self.config)
        if not base_url:
            raise GatewayError("未配置网关端点")
        url = f"{_normalized_base_url(base_url)}/{path.lstrip('/')}"
        body = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if payload is not None
            else None
        )
        last_error = "请求失败"
        for attempt in range(self.config.retries + 1):
            try:
                status, _, response = self.transport.request(
                    method,
                    url,
                    headers=self._headers(),
                    body=body,
                    timeout=self.config.timeout,
                )
                if not 200 <= status < 300:
                    raise GatewayError(f"HTTP 状态码 {status}")
                return _json_object(response)
            except GatewayError as exc:
                last_error = _safe_error(str(exc), api_key)
            except Exception as exc:  # noqa: BLE001 - 注入传输异常也必须脱敏降级
                last_error = _safe_error(f"传输异常：{type(exc).__name__}", api_key)
            if attempt < self.config.retries and self._sleep is not None:
                self._sleep(self.config.backoff * (2**attempt))
        raise GatewayError(last_error)

    def refresh_models(self) -> ModelSelection:
        """同步刷新，供后台线程或显式维护调用；普通启动应使用 start_refresh。"""
        try:
            payload = self._request_json("GET", "models")
            models = _extract_models(payload)
            if not models:
                raise GatewayError("模型列表为空")
            self._save_cache(models)
            selection = select_model(
                (model.id for model in models),
                score_path=self.config.score_path,
                fallback=self.config.deepseek_model,
            )
            with self._lock:
                self._models = models
                self._selection = selection
            return selection
        except GatewayError:
            cached = self._cached_selection()
            with self._lock:
                self._selection = cached
            return cached

    def start_refresh(self) -> Future[ModelSelection]:
        """立即返回后台刷新任务，本地启动不等待网络。"""
        with self._lock:
            if self._refresh_future is None or self._refresh_future.done():
                executor = self._executor or ThreadPoolExecutor(max_workers=1)
                self._refresh_future = executor.submit(self.refresh_models)
            return self._refresh_future

    def _cached_selection(self) -> ModelSelection:
        with self._lock:
            cached_ids = tuple(model.id for model in self._models)
        if cached_ids:
            selected = select_model(
                cached_ids,
                score_path=self.config.score_path,
                fallback=self.config.deepseek_model,
            )
            return replace(selected, status="cached")
        return select_model(
            (),
            score_path=self.config.score_path,
            fallback=self.config.deepseek_model,
            allow_offline_fallback=True,
        )

    def _load_cache(self) -> None:
        try:
            payload = json.loads(self.config.cache_path.read_text(encoding="utf-8"))
            rows = payload.get("models") if isinstance(payload, Mapping) else None
            if not isinstance(rows, list):
                return
            models = tuple(
                ModelInfo(item["id"], item.get("owned_by", ""), item.get("created"))
                for item in rows
                if isinstance(item, Mapping) and isinstance(item.get("id"), str)
            )
            self._models = models
            self._selection = self._cached_selection()
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
            return

    def _save_cache(self, models: Sequence[ModelInfo]) -> None:
        try:
            self.config.cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"schema_version": 1, "models": [asdict(item) for item in models]}
            temporary = self.config.cache_path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
            )
            temporary.replace(self.config.cache_path)
        except OSError:
            # 缓存写入失败不阻断在线名单使用。
            return

    @staticmethod
    def cache_key(model: str, messages: Sequence[Mapping[str, Any]], **options: Any) -> str:
        payload = {"model": model, "messages": messages, "options": options}
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return sha256(encoded.encode("utf-8")).hexdigest()

    def chat(
        self,
        messages: Sequence[Mapping[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.0,
        max_tokens: int = 512,
        response_format: Mapping[str, Any] | None = None,
        use_cache: bool = True,
    ) -> ChatResult:
        selected = model or self.selection.model
        if not selected:
            return self._failed_chat("", "unavailable", "没有已核验的可用模型")
        key = self.cache_key(
            selected,
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
        )
        if use_cache:
            with self._lock:
                cached = self._cache.get(key)
            if cached is not None:
                usage = UsageRecord(key, None, None, None, None, 0.0, None, "cached", selected)
                self._record_usage(usage)
                return ChatResult("cached", cached.content, cached.model, usage)
        payload: dict[str, Any] = {
            "model": selected,
            "messages": list(messages),
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format is not None:
            payload["response_format"] = dict(response_format)
        started = self._timer()
        try:
            response = self._request_json("POST", "chat/completions", payload)
            content, response_model, usage = self._parse_chat(response, selected, key, started)
        except GatewayError as exc:
            return self._failed_chat(key, selected, str(exc), started)
        if use_cache:
            with self._lock:
                self._cache[key] = _CacheEntry(content, response_model, self._clock())
        self._record_usage(usage)
        return ChatResult("ok", content, response_model, usage)

    def _parse_chat(
        self,
        response: Mapping[str, Any],
        requested_model: str,
        cache_key: str,
        started: float,
    ) -> tuple[str, str, UsageRecord]:
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
            raise GatewayError("聊天响应缺少 choices")
        message = choices[0].get("message")
        content = message.get("content") if isinstance(message, Mapping) else None
        if not isinstance(content, str) or not content.strip():
            raise GatewayError("聊天响应为空")
        model = response.get("model")
        model = model if isinstance(model, str) and model else requested_model
        request_id = response.get("id") if isinstance(response.get("id"), str) else None
        raw_usage = response.get("usage")
        usage = raw_usage if isinstance(raw_usage, Mapping) else {}

        def token(name: str) -> int | None:
            value = usage.get(name)
            return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None

        cost_value = usage.get("cost")
        if cost_value is None:
            cost_value = usage.get("total_cost")
        try:
            cost = Decimal(str(cost_value)) if cost_value is not None else None
            if cost is not None and (not cost.is_finite() or cost < 0):
                cost = None
        except InvalidOperation:
            cost = None
        record = UsageRecord(
            cache_key,
            request_id,
            token("prompt_tokens"),
            token("completion_tokens"),
            token("total_tokens"),
            max(0.0, self._timer() - started),
            cost,
            "ok",
            model,
        )
        return content.strip(), model, record

    def _failed_chat(
        self, key: str, model: str, error: str, started: float | None = None
    ) -> ChatResult:
        elapsed = max(0.0, self._timer() - started) if started is not None else 0.0
        usage = UsageRecord(key, None, None, None, None, elapsed, None, "error", model)
        self._record_usage(usage)
        return ChatResult("degraded", None, model or None, usage, _safe_error(error))

    def _record_usage(self, usage: UsageRecord) -> None:
        with self._lock:
            self._usage.append(usage)
            if len(self._usage) > 1000:
                del self._usage[: len(self._usage) - 1000]

    def action_advice(self, view: AgentView, **options: Any) -> ActionAdvice:
        actions = [asdict(action) for action in legal_actions(view)]
        prompt = (
            "只返回 JSON 对象 {\"action\":{...},\"reason\":\"...\"}。"
            "只能复制候选动作，reason 使用简体中文。"
        )
        result = self.chat(
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps({"actions": actions}, ensure_ascii=False)},
            ],
            response_format={"type": "json_object"},
            **options,
        )
        return validate_action_advice(result.content, view)

    def path_explanation(
        self, view: AgentView, actions: Sequence[Action], **options: Any
    ) -> VerifiedPathExplanation:
        reward = path_reward(view, actions)
        if not reward.verified:
            return VerifiedPathExplanation("degraded", None, (), len(actions))
        visible = sorted(
            {
                record.evidence.evidence_id
                for record in view.observations
                if record.evidence.received_at <= view.tick
                and record.evidence.observed_at <= view.tick
            }
        )
        prompt = (
            "解释已验证路径。只返回 {\"explanation\":\"...\",\"evidence_ids\":[...]}，"
            "evidence_ids 只能从给定列表选择。"
        )
        result = self.chat(
            [
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"actions": [asdict(item) for item in actions], "evidence_ids": visible},
                        ensure_ascii=False,
                    ),
                },
            ],
            response_format={"type": "json_object"},
            **options,
        )
        return validate_path_explanation(result.content, view, actions)

    def search_suggestion(
        self, query: str, *, allowed_terms: Iterable[str], **options: Any
    ) -> SearchSuggestion:
        """生成知识图谱检索词，只返回白名单中的词；失败时保留原查询词。"""
        allowed = tuple(dict.fromkeys(term.strip() for term in allowed_terms if term.strip()))
        fallback = tuple(term for term in query.split() if term in allowed)
        prompt = (
            "为知识图谱搜索选择检索词。只返回 {\"query_terms\":[...],\"reason\":\"...\"}；"
            "query_terms 只能来自 allowed_terms。"
        )
        result = self.chat(
            [
                {"role": "system", "content": prompt},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"query": query, "allowed_terms": allowed}, ensure_ascii=False
                    ),
                },
            ],
            response_format={"type": "json_object"},
            **options,
        )
        try:
            data = json.loads(result.content or "")
            terms, reason = data["query_terms"], data["reason"]
            if (
                set(data) != {"query_terms", "reason"}
                or not isinstance(terms, list)
                or not terms
                or not all(isinstance(term, str) and term in allowed for term in terms)
                or len(terms) != len(set(terms))
                or not isinstance(reason, str)
                or not reason.strip()
            ):
                raise ValueError
            return SearchSuggestion("ok", tuple(terms), reason.strip()[:500], "llm")
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            return SearchSuggestion(
                "fallback", fallback, "LLM 响应无效，使用查询中的白名单词", "fallback"
            )

    def evaluate_kg_actions(
        self,
        question: str,
        path_entities: Sequence[str],
        path_relations: Sequence[str],
        candidates: Sequence[KGActionCandidate | Mapping[str, Any]],
        **options: Any,
    ) -> KGActionEvaluation:
        """批量评估知识图谱动作；输出只能重排调用方候选，不能产生新实体。"""
        try:
            question = _nonempty_text(question, "问题文本")
            entities, relations = _normalize_kg_path(path_entities, path_relations)
            normalized = _normalize_kg_candidates(candidates)
        except ValueError as exc:
            return KGActionEvaluation("degraded", (), _safe_error(str(exc)))
        prompt = (
            "你是知识图谱路径动作评估器。只返回 {\"scores\":[{\"action_id\":\"...\","
            "\"reward\":0.0,\"legal\":true,\"reason\":\"...\"}]}。"
            "每个候选恰好一项，action_id 只能复制输入，reward 必须在 [-1,1]，"
            "不得输出目标实体、答案或新候选。"
        )
        request = {
            "question": question,
            "current_path": {"entities": list(entities), "relations": list(relations)},
            "candidates": [asdict(candidate) for candidate in normalized],
        }
        options.setdefault("max_tokens", 4096)
        result = self.chat(
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(request, ensure_ascii=False)},
            ],
            response_format={"type": "json_object"},
            **options,
        )
        return validate_kg_action_evaluation(result.content, normalized)

    def explain_kg_path(
        self,
        path_triples: Sequence[Sequence[str]],
        source_titles: Sequence[str],
        **options: Any,
    ) -> KGPathExplanation:
        """解释已验证路径；evidence_ids 只能引用给定来源标题的派生 ID。"""
        try:
            triples = _normalize_path_triples(path_triples)
            sources = _normalize_source_titles(source_titles)
        except ValueError as exc:
            return KGPathExplanation("degraded", None, (), _safe_error(str(exc)))
        prompt = (
            "解释给定知识图谱路径。只返回一个 JSON 对象，字段为 explanation 字符串和 "
            "evidence_ids 字符串数组。evidence_ids 只能复制给定来源 ID，"
            "不得补充实体、事实或来源。"
        )
        request = {
            "path": [
                {"source": source, "relation": relation, "target": target}
                for source, relation, target in triples
            ],
            "sources": [
                {"evidence_id": evidence_id, "title": title}
                for evidence_id, title in sources
            ],
        }
        options.setdefault("max_tokens", 4096)
        result = self.chat(
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(request, ensure_ascii=False)},
            ],
            response_format={"type": "json_object"},
            **options,
        )
        return validate_kg_path_explanation(result.content, triples, source_titles)


def benchmark_endpoints(
    endpoints: Sequence[str],
    *,
    rounds: int = 3,
    config: GatewayConfig | None = None,
    api_key_env: str = "AXONHUB_API_KEY",
    transport: Transport | None = None,
    timer: Callable[[], float] = perf_counter,
) -> EndpointBenchmark:
    """对每个端点做固定轮数测速；候选按中位延迟、端点字典序排列。"""
    if rounds <= 0:
        raise ValueError("rounds 必须为正整数")
    if len(endpoints) != 8:
        raise ValueError("端点测速要求恰好 8 个端点")
    base_config = config or GatewayConfig()
    transport = transport or UrllibTransport()
    results: list[EndpointResult] = []
    for endpoint in endpoints:
        try:
            normalized = _normalized_base_url(endpoint)
        except ValueError as exc:
            results.append(EndpointResult(endpoint, "invalid", (), None, (), str(exc)))
            continue
        samples: list[float] = []
        models: tuple[str, ...] = ()
        error: str | None = None
        api_key = environ.get(api_key_env, "")
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        for _ in range(rounds):
            started = timer()
            try:
                status, _, payload = transport.request(
                    "GET",
                    f"{normalized}/models",
                    headers=headers,
                    body=None,
                    timeout=base_config.timeout,
                )
                if not 200 <= status < 300:
                    raise GatewayError(f"HTTP 状态码 {status}")
                models = tuple(model.id for model in _extract_models(_json_object(payload)))
                samples.append(max(0.0, (timer() - started) * 1000.0))
            except Exception as exc:  # noqa: BLE001 - 任一注入传输故障都只标记该端点失败
                error = _safe_error(str(exc), api_key)
                break
        if len(samples) == rounds:
            results.append(
                EndpointResult(endpoint, "ok", tuple(samples), float(median(samples)), models)
            )
        else:
            results.append(EndpointResult(endpoint, "failed", tuple(samples), None, models, error))
    candidates = tuple(
        item.endpoint
        for item in sorted(
            (item for item in results if item.status == "ok"),
            key=lambda item: (item.median_ms or float("inf"), item.endpoint),
        )
    )
    return EndpointBenchmark(tuple(results), candidates)


def gateway_status(gateway: LLMGateway) -> dict[str, Any]:
    """供 API 适配层读取的稳定状态字典，不包含凭据。"""
    selection = gateway.selection
    return {
        "status": selection.status,
        "model": selection.model or None,
        "score": selection.score,
        "score_version": selection.score_version,
        "available_models": list(selection.available_models),
        "usage_count": len(gateway.usage_records),
    }


__all__ = [
    "DEFAULT_DEEPSEEK_MODEL",
    "ActionAdvice",
    "ChatResult",
    "EndpointBenchmark",
    "EndpointResult",
    "GatewayConfig",
    "GatewayError",
    "KGActionCandidate",
    "KGActionEvaluation",
    "KGActionScore",
    "KGPathExplanation",
    "LLMGateway",
    "ModelInfo",
    "ModelSelection",
    "PathReward",
    "SearchSuggestion",
    "UsageRecord",
    "VerifiedPathExplanation",
    "benchmark_endpoints",
    "gateway_status",
    "kg_source_evidence_id",
    "path_reward",
    "select_model",
    "validate_action_advice",
    "validate_kg_action_evaluation",
    "validate_kg_path_explanation",
    "validate_path_explanation",
]
