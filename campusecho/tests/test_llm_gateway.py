"""LLM 网关的离线行为测试；所有 HTTP 与时间均由夹具注入。"""

from __future__ import annotations

import json
from pathlib import Path
from threading import Event

import pytest

from campusecho.llm_gateway import (
    GatewayConfig,
    GatewayError,
    KGActionCandidate,
    LLMGateway,
    benchmark_endpoints,
    gateway_status,
    kg_source_evidence_id,
    path_reward,
    select_model,
    validate_action_advice,
    validate_kg_action_evaluation,
    validate_kg_path_explanation,
    validate_path_explanation,
)
from campusecho.world import Action, legal_actions, observe, scenario

SECRET = "sk-test-never-leak-7f31"


class FakeTransport:
    def __init__(self, responses=None, *, models=None, chat=None):
        self.responses = list(responses or [])
        self.models = models or [{"id": "gpt-6.1-sol"}, {"id": "deepseek-flash"}]
        self.chat = chat
        self.calls = []
        self.authorization_present = []

    def request(self, method, url, *, headers, body, timeout):
        # 传输层必须收到鉴权头，但调用记录只保存脱敏后的可观察信息。
        self.authorization_present.append(
            headers.get("Authorization", "").startswith("Bearer ")
        )
        safe_headers = {
            key: "[REDACTED]" if key.lower() == "authorization" else value
            for key, value in headers.items()
        }
        self.calls.append((method, url, safe_headers, body, timeout))
        if self.responses:
            response = self.responses.pop(0)
            if isinstance(response, BaseException):
                raise response
            return response
        if method == "GET" and url.endswith("/models"):
            return 200, {}, json.dumps({"data": self.models}).encode()
        if method == "POST" and url.endswith("/chat/completions"):
            if isinstance(self.chat, BaseException):
                raise self.chat
            payload = self.chat or {
                "id": "req-1",
                "model": "gpt-6.1-sol",
                "choices": [{"message": {"content": "{\"ok\":true}"}}],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 3,
                    "total_tokens": 11,
                    "cost": "0.0012",
                },
            }
            return 200, {}, json.dumps(payload).encode()
        raise AssertionError(f"未预期请求：{method} {url}")


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        self.value += 1.0
        return self.value


def _config(tmp_path: Path, monkeypatch=None, **changes):
    if monkeypatch is not None:
        monkeypatch.setenv("AXONHUB_API_KEY", SECRET)
    values = {
        "base_url": "https://gateway.example/v1",
        "cache_path": tmp_path / "models.json",
        "score_path": tmp_path / "scores.json",
        "timeout": 1.5,
        "retries": 2,
        "backoff": 0.0,
    }
    values.update(changes)
    return GatewayConfig(**values)


def _write_scores(tmp_path: Path, models):
    payload = {
        "schema_version": 1,
        "score_version": "test-v1",
        "models": models,
    }
    (tmp_path / "scores.json").write_text(json.dumps(payload), encoding="utf-8")


def test_model_selection_uses_live_exact_scores_and_never_guesses(tmp_path):
    _write_scores(
        tmp_path,
        {
            "gpt-6.1-sol": {"score": 55, "verified": True},
            "gpt-6.1-terra-max": {"score": 51, "verified": True},
            "unscored-highest": {"verified": True},
            "offline-model": {"score": 99, "verified": True},
            "not-verified": {"score": 100, "verified": False},
        },
    )
    selected = select_model(
        ["unscored-highest", "not-verified", "gpt-6.1-terra-max", "gpt-6.1-sol"],
        score_path=tmp_path / "scores.json",
    )
    assert selected.model == "gpt-6.1-sol"
    assert selected.score == 55
    assert selected.status == "online"
    assert "offline-model" not in selected.available_models


def test_refresh_retries_then_uses_cache_and_does_not_block_start(tmp_path, monkeypatch):
    _write_scores(
        tmp_path,
        {
            "gpt-6.1-sol": {"score": 55, "verified": True},
            "deepseek-flash": {"score": 33, "verified": True},
        },
    )
    first = FakeTransport()
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=first, clock=Clock())
    assert gateway.refresh_models().model == "gpt-6.1-sol"
    assert (tmp_path / "models.json").exists()

    failing = FakeTransport([GatewayError("断网"), GatewayError("断网"), GatewayError("断网")])
    restored = LLMGateway(_config(tmp_path, monkeypatch), transport=failing, clock=Clock())
    selection = restored.refresh_models()
    assert selection.status == "cached"
    assert selection.model == "gpt-6.1-sol"
    assert len(failing.calls) == 3

    entered = Event()
    release = Event()

    class SlowTransport(FakeTransport):
        def request(self, *args, **kwargs):
            entered.set()
            release.wait(timeout=2)
            return super().request(*args, **kwargs)

    slow = LLMGateway(_config(tmp_path, monkeypatch), transport=SlowTransport(), clock=Clock())
    future = slow.start_refresh()
    assert entered.wait(timeout=1)
    assert not future.done()
    release.set()
    assert future.result(timeout=2).model == "gpt-6.1-sol"


def test_offline_without_cache_falls_back_to_deepseek_then_unavailable(tmp_path, monkeypatch):
    _write_scores(
        tmp_path,
        {
            "gpt-6.1-sol": {"score": 55, "verified": True},
            "deepseek-flash": {"score": 33, "verified": True},
        },
    )
    transport = FakeTransport([GatewayError("断网")] * 3)
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=transport, clock=Clock())
    assert gateway.refresh_models().status == "deepseek"

    no_fallback = LLMGateway(
        _config(tmp_path, monkeypatch, deepseek_model=""),
        transport=FakeTransport([GatewayError("断网")] * 3),
        clock=Clock(),
    )
    assert no_fallback.refresh_models().status == "unavailable"


def test_delisted_model_is_not_selected_from_stale_cache(tmp_path, monkeypatch):
    _write_scores(
        tmp_path,
        {
            "gpt-6.1-sol": {"score": 55, "verified": True},
            "deepseek-flash": {"score": 33, "verified": True},
        },
    )
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=FakeTransport(), clock=Clock())
    gateway.refresh_models()
    gateway.transport = FakeTransport(models=[{"id": "deepseek-flash"}])
    assert gateway.refresh_models().model == "deepseek-flash"


@pytest.mark.parametrize(
    "response",
    [
        None,
        "",
        "   ",
        "not-json",
        '{"action":{"kind":"teleport"},"reason":"x"}',
        '{"action":{"kind":"wait","minutes":NaN},"reason":"x"}',
        '{"action":{"kind":"wait","minutes":999},"reason":"x"}',
        '{"action":{"kind":"wait"},"reason":""}',
    ],
)
def test_bad_action_advice_degrades(response):
    view = observe(scenario("mission"), "player")
    result = validate_action_advice(response, view)
    assert result.status == "degraded"
    assert result.action is None
    assert result.legal is False


def test_valid_action_advice_is_checked_against_legal_actions():
    view = observe(scenario("mission"), "player")
    action = next(item for item in legal_actions(view) if item.kind == "wait")
    result = validate_action_advice(
        json.dumps({"action": action.__dict__, "reason": "等待一分钟"}), view
    )
    assert result.status == "ok"
    assert result.action == action
    assert result.legal


def test_chat_bad_json_whitespace_timeout_and_usage_are_safe(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    clock = Clock()
    gateway = LLMGateway(
        _config(tmp_path, monkeypatch), transport=FakeTransport(), clock=clock, timer=clock
    )
    gateway.refresh_models()
    result = gateway.chat([{"role": "user", "content": "hi"}])
    assert result.status == "ok"
    assert result.usage.prompt_tokens == 8
    assert str(result.usage.cost) == "0.0012"
    assert result.usage.elapsed_seconds > 0

    blank = FakeTransport(chat={"choices": [{"message": {"content": "   "}}]})
    gateway.transport = blank
    result = gateway.chat([{"role": "user", "content": "blank"}], use_cache=False)
    assert result.status == "degraded"
    assert result.content is None
    assert result.usage.total_tokens is None

    timeout = FakeTransport([TimeoutError(SECRET)] * 3)
    gateway.transport = timeout
    result = gateway.chat([{"role": "user", "content": "timeout"}], use_cache=False)
    assert result.status == "degraded"
    assert SECRET not in json.dumps(result.usage.as_dict(), ensure_ascii=False)
    assert SECRET not in (result.error or "")
    assert len(timeout.calls) == 3


def test_cache_key_is_stable_and_cache_hit_records_usage(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    transport = FakeTransport()
    clock = Clock()
    gateway = LLMGateway(
        _config(tmp_path, monkeypatch), transport=transport, clock=clock, timer=clock
    )
    gateway.refresh_models()
    messages = [{"role": "user", "content": "same"}]
    first = gateway.chat(messages, max_tokens=12)
    second = gateway.chat(messages, max_tokens=12)
    assert first.status == "ok"
    assert second.status == "cached"
    assert len([call for call in transport.calls if call[0] == "POST"]) == 1
    assert gateway.usage_records[-1].status == "cached"
    assert gateway.usage_records[-1].cache_key == gateway.usage_records[-2].cache_key


def test_endpoint_benchmark_uses_three_rounds_and_skips_failures(monkeypatch):
    endpoints = tuple(f"https://node-{index}.example/v1" for index in range(8))

    class TimedTransport:
        def __init__(self):
            self.calls = {}

        def request(self, method, url, *, headers, body, timeout):
            node = url.split("//", 1)[1].split(".", 1)[0]
            self.calls[node] = self.calls.get(node, 0) + 1
            if node == "node-1":
                raise TimeoutError("offline")
            return 200, {}, json.dumps({"data": [{"id": "gpt-6.1-sol"}]}).encode()

    times = iter([0.0, 0.1, 0.0, 0.2, 0.0, 0.3] + [float(index) for index in range(100)])
    transport = TimedTransport()
    monkeypatch.setenv("AXONHUB_API_KEY", SECRET)
    result = benchmark_endpoints(
        endpoints,
        rounds=3,
        config=GatewayConfig(timeout=1),
        transport=transport,
        timer=lambda: next(times),
    )
    assert len(result.results) == 8
    assert all(len(item.samples_ms) == 3 for item in result.results if item.status == "ok")
    assert result.results[1].status == "failed"
    assert transport.calls["node-1"] == 1
    assert result.candidates[0] == endpoints[0]
    assert SECRET not in json.dumps(result.as_dict(), ensure_ascii=False)


def test_endpoint_benchmark_requires_exactly_eight_and_positive_rounds():
    endpoints = tuple(f"https://node-{index}.example/v1" for index in range(8))
    with pytest.raises(ValueError, match="8"):
        benchmark_endpoints(endpoints[:7], transport=FakeTransport())
    with pytest.raises(ValueError, match="rounds"):
        benchmark_endpoints(endpoints, rounds=0, transport=FakeTransport())


def test_path_reward_and_explanation_require_verified_actions():
    world = scenario("mission", 17)
    view = observe(world, "player")
    actions = (
        Action("move", target="walkway", minutes=4),
        Action("move", target="club", minutes=4),
    )
    reward = path_reward(view, actions)
    assert reward.status == "ok"
    assert reward.verified
    assert reward.reward == 2.0

    bad = path_reward(view, (Action("move", target="venue", minutes=1),))
    assert bad.status == "invalid"
    assert bad.reward is None
    assert validate_path_explanation(
        '{"explanation":"x","evidence_ids":[]}', view, (Action("move", target="venue"),)
    ).status == "degraded"

    evidence_id = view.observations[0].evidence.evidence_id
    explanation = validate_path_explanation(
        json.dumps({"explanation": "依据可见线索移动", "evidence_ids": [evidence_id]}),
        view,
        actions,
    )
    assert explanation.status == "ok"
    assert explanation.evidence_ids == (evidence_id,)


def test_search_suggestion_is_whitelisted_and_falls_back(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    transport = FakeTransport(
        chat={
            "model": "gpt-6.1-sol",
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"query_terms": ["图书馆"], "reason": "匹配地点"}, ensure_ascii=False
                        )
                    }
                }
            ],
        }
    )
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=transport, clock=Clock())
    gateway.refresh_models()
    suggestion = gateway.search_suggestion("去 图书馆", allowed_terms=("图书馆", "小汐"))
    assert suggestion.status == "ok"
    assert suggestion.query_terms == ("图书馆",)

    gateway.transport = FakeTransport(chat={"choices": [{"message": {"content": "bad"}}]})
    fallback = gateway.search_suggestion(
        "图书馆 未知", allowed_terms=("图书馆", "小汐"), use_cache=False
    )
    assert fallback.status == "fallback"
    assert fallback.query_terms == ("图书馆",)


def test_status_and_errors_never_expose_api_key(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    transport = FakeTransport([GatewayError(f"bad {SECRET}")] * 3)
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=transport, clock=Clock())
    selection = gateway.refresh_models()
    status = gateway_status(gateway)
    serialized = json.dumps(status, ensure_ascii=False)
    assert selection.status == "deepseek"
    assert SECRET not in serialized
    assert SECRET not in repr(transport.calls)
    assert transport.authorization_present == [True, True, True]

    with pytest.raises(ValueError, match="凭据"):
        LLMGateway(_config(tmp_path, monkeypatch, base_url="https://user:pass@example/v1")).refresh_models()


def _kg_candidates():
    return (
        KGActionCandidate("a1", "located_in", "图书馆"),
        KGActionCandidate("a2", "studies_at", "计算机学院"),
        KGActionCandidate("a3", "member_of", "摄影社"),
    )


def _kg_chat(content):
    return {
        "id": "kg-request",
        "model": "gpt-6.1-sol",
        "choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)}}],
        "usage": {"prompt_tokens": 20, "completion_tokens": 12, "total_tokens": 32},
    }


def test_kg_action_evaluation_accepts_complete_candidate_scores_in_input_order():
    candidates = _kg_candidates()
    payload = {
        "scores": [
            {"action_id": "a3", "reward": 0.4, "legal": True, "reason": "社团关系相关"},
            {"action_id": "a1", "reward": 0.9, "legal": True, "reason": "地点关系相关"},
            {"action_id": "a2", "reward": -0.2, "legal": False, "reason": "学院关系较弱"},
        ]
    }
    result = validate_kg_action_evaluation(payload, candidates)
    assert result.status == "ok"
    assert [item.action_id for item in result.scores] == ["a1", "a2", "a3"]
    assert result.scores[0].reward == 0.9
    assert result.scores[1].legal is False


@pytest.mark.parametrize(
    "payload",
    [
        None,
        "",
        "   ",
        "not-json",
        {"scores": []},
        {"scores": [{"action_id": "a1", "reward": 0.1, "legal": True, "reason": "x"}]},
        {
            "scores": [
                {"action_id": "a1", "reward": 0.1, "legal": True, "reason": "x"},
                {"action_id": "a1", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "a3", "reward": 0.3, "legal": True, "reason": "x"},
            ]
        },
        {
            "scores": [
                {"action_id": "a1", "reward": 0.1, "legal": True, "reason": "x"},
                {"action_id": "a2", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "hallucinated", "reward": 0.3, "legal": True, "reason": "x"},
            ]
        },
        {
            "scores": [
                {"action_id": "a1", "reward": 1.1, "legal": True, "reason": "x"},
                {"action_id": "a2", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "a3", "reward": 0.3, "legal": True, "reason": "x"},
            ]
        },
        {
            "scores": [
                {"action_id": "a1", "reward": float("nan"), "legal": True, "reason": "x"},
                {"action_id": "a2", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "a3", "reward": 0.3, "legal": True, "reason": "x"},
            ]
        },
        {
            "scores": [
                {"action_id": "a1", "reward": 0.1, "legal": True, "reason": "x"},
                {"action_id": "a2", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "a3", "reward": 0.3, "legal": "yes", "reason": "x"},
            ]
        },
        {
            "scores": [
                {"action_id": "a1", "reward": 0.1, "legal": True, "reason": "x"},
                {"action_id": "a2", "reward": 0.2, "legal": True, "reason": "x"},
                {"action_id": "a3", "reward": 0.3, "legal": True, "reason": ""},
            ]
        },
    ],
)
def test_kg_action_evaluation_degrades_whole_batch(payload):
    result = validate_kg_action_evaluation(payload, _kg_candidates())
    assert result.status == "degraded"
    assert result.scores == ()
    assert result.error


def test_kg_action_evaluation_rejects_duplicate_or_invalid_candidates():
    duplicate = (
        KGActionCandidate("a1", "located_in", "图书馆"),
        KGActionCandidate("a1", "member_of", "摄影社"),
    )
    assert validate_kg_action_evaluation({"scores": []}, duplicate).status == "degraded"
    assert validate_kg_action_evaluation({"scores": []}, ()).status == "degraded"
    assert (
        validate_kg_action_evaluation(
            {"scores": []}, [{"action_id": "a1", "relation": "x", "target_label": "", "answer": "x"}]
        ).status
        == "degraded"
    )


def test_kg_action_gateway_degrades_blank_json_without_network_fallback(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    transport = FakeTransport(chat={"choices": [{"message": {"content": "   "}}]})
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=transport, clock=Clock())
    gateway.refresh_models()
    result = gateway.evaluate_kg_actions("问题", ("小汐",), (), _kg_candidates())
    assert result.status == "degraded"
    assert result.scores == ()
    assert len([call for call in transport.calls if call[0] == "POST"]) == 1
    assert gateway.usage_records[-1].status == "error"


def test_kg_action_gateway_uses_chat_cache_usage_and_never_emits_answer_entity(
    tmp_path, monkeypatch
):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    content = {
        "scores": [
            {"action_id": "a1", "reward": 0.8, "legal": True, "reason": "地点相关"},
            {"action_id": "a2", "reward": 0.1, "legal": True, "reason": "学院相关"},
            {"action_id": "a3", "reward": -0.1, "legal": False, "reason": "社团较弱"},
        ]
    }
    transport = FakeTransport(chat=_kg_chat(content))
    clock = Clock()
    gateway = LLMGateway(
        _config(tmp_path, monkeypatch), transport=transport, clock=clock, timer=clock
    )
    gateway.refresh_models()
    candidates = _kg_candidates()
    first = gateway.evaluate_kg_actions(
        "小汐在哪里？", ("小汐",), (), candidates, max_tokens=128
    )
    second = gateway.evaluate_kg_actions(
        "小汐在哪里？", ("小汐",), (), candidates, max_tokens=128
    )
    assert first.status == second.status == "ok"
    assert second.scores == first.scores
    assert [item.action_id for item in first.scores] == ["a1", "a2", "a3"]
    assert len([call for call in transport.calls if call[0] == "POST"]) == 1
    assert gateway.usage_records[-1].status == "cached"
    assert gateway.usage_records[-1].cache_key == gateway.usage_records[-2].cache_key
    request_body = json.loads(next(call[3] for call in transport.calls if call[0] == "POST"))
    user_payload = json.loads(request_body["messages"][1]["content"])
    assert set(user_payload["candidates"][0]) == {"action_id", "relation", "target_label"}
    assert "answer" not in user_payload
    assert SECRET not in repr(transport.calls)


def test_kg_action_gateway_hallucination_and_network_failure_degrade(tmp_path, monkeypatch):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    hallucinated = {
        "scores": [
            {"action_id": "a1", "reward": 0.8, "legal": True, "reason": "地点相关"},
            {"action_id": "a2", "reward": 0.1, "legal": True, "reason": "学院相关"},
            {"action_id": "invented", "reward": 1, "legal": True, "reason": "伪造"},
        ]
    }
    transport = FakeTransport(chat=_kg_chat(hallucinated))
    gateway = LLMGateway(_config(tmp_path, monkeypatch), transport=transport, clock=Clock())
    gateway.refresh_models()
    result = gateway.evaluate_kg_actions("问题", ("小汐",), (), _kg_candidates())
    assert result.status == "degraded"
    assert result.scores == ()

    timeout = FakeTransport([TimeoutError(SECRET)] * 3)
    gateway.transport = timeout
    result = gateway.evaluate_kg_actions(
        "断网问题", ("小汐",), (), _kg_candidates(), use_cache=False
    )
    assert result.status == "degraded"
    assert SECRET not in (result.error or "")
    assert SECRET not in repr(timeout.calls)
    assert len(timeout.calls) == 3


def test_kg_path_explanation_accepts_only_derived_source_ids():
    triples = (("小汐", "member_of", "摄影社"), ("摄影社", "located_in", "学生活动中心"))
    titles = ("社团成员表", "活动室登记表")
    evidence_ids = tuple(kg_source_evidence_id(title) for title in titles)
    payload = {
        "explanation": "成员关系与活动室登记共同支持这条路径。",
        "evidence_ids": [evidence_ids[1], evidence_ids[0]],
    }
    result = validate_kg_path_explanation(payload, triples, titles)
    assert result.status == "ok"
    assert result.evidence_ids == (evidence_ids[1], evidence_ids[0])

    for bad in (
        None,
        "   ",
        {"explanation": "x", "evidence_ids": ["source:invented"]},
        {"explanation": "x", "evidence_ids": []},
        {"explanation": "x", "evidence_ids": [evidence_ids[0], evidence_ids[0]]},
        {"explanation": "", "evidence_ids": [evidence_ids[0]]},
        {"explanation": "x", "evidence_ids": [evidence_ids[0]], "answer": "学生活动中心"},
    ):
        assert validate_kg_path_explanation(bad, triples, titles).status == "degraded"
    assert validate_kg_path_explanation(payload, (("a", "x", "b"), ("c", "y", "d")), titles).status == "degraded"


def test_kg_path_explanation_gateway_uses_cache_and_rejects_unknown_source(
    tmp_path, monkeypatch
):
    _write_scores(tmp_path, {"gpt-6.1-sol": {"score": 55, "verified": True}})
    triples = (("小汐", "member_of", "摄影社"),)
    titles = ("社团成员表",)
    evidence_id = kg_source_evidence_id(titles[0])
    content = {"explanation": "成员表支持该路径。", "evidence_ids": [evidence_id]}
    transport = FakeTransport(chat=_kg_chat(content))
    clock = Clock()
    gateway = LLMGateway(
        _config(tmp_path, monkeypatch), transport=transport, clock=clock, timer=clock
    )
    gateway.refresh_models()
    first = gateway.explain_kg_path(triples, titles, max_tokens=96)
    second = gateway.explain_kg_path(triples, titles, max_tokens=96)
    assert first.status == second.status == "ok"
    assert second.evidence_ids == (evidence_id,)
    assert len([call for call in transport.calls if call[0] == "POST"]) == 1
    assert gateway.usage_records[-1].status == "cached"

    invented = FakeTransport(
        chat=_kg_chat({"explanation": "伪造来源", "evidence_ids": ["source:invented"]})
    )
    gateway.transport = invented
    result = gateway.explain_kg_path(triples, titles, use_cache=False)
    assert result.status == "degraded"
    assert result.explanation is None
    assert SECRET not in repr(invented.calls)

