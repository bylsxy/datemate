"""LLM-guided A* search for the report-three comparison.

The LLM receives only the public question, the current path and candidate
relations/entities.  It never receives private answers.  The local validator
still decides whether a score batch is usable; a degraded or invalid batch
falls back to the ordinary A* heuristic.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite
from time import perf_counter
from typing import Literal

from .kg_data import KGData, QuestionPublic
from .kg_experiment import SearchRun, _question_problem
from .kg_search import SearchConfig, SearchState, astar
from .llm_gateway import KGActionCandidate, KGActionEvaluation

CorruptionMode = Literal["none", "flip", "random"]


@dataclass
class LLMUsage:
    calls: int = 0
    ok_calls: int = 0
    degraded_calls: int = 0
    cached_calls: int = 0
    scored_actions: int = 0
    elapsed_seconds: float = 0.0
    errors: tuple[str, ...] = ()

    def merge(self, other: LLMUsage) -> LLMUsage:
        return LLMUsage(
            self.calls + other.calls,
            self.ok_calls + other.ok_calls,
            self.degraded_calls + other.degraded_calls,
            self.cached_calls + other.cached_calls,
            self.scored_actions + other.scored_actions,
            self.elapsed_seconds + other.elapsed_seconds,
            self.errors + other.errors,
        )

    @property
    def status(self) -> str:
        if self.calls == 0:
            return "disabled"
        if self.degraded_calls == self.calls:
            return "degraded"
        if self.degraded_calls:
            return "partial"
        return "ok"

    @property
    def degrade_rate(self) -> float:
        return self.degraded_calls / max(1, self.calls)


@dataclass(frozen=True)
class LLMSearchResult:
    search: SearchRun
    usage: LLMUsage


def _entity_id(node: object) -> str:
    if isinstance(node, tuple) and node:
        return str(node[0])
    return str(node)


def _corrupt(value: float, mode: CorruptionMode, index: int) -> float:
    if mode == "none":
        return value
    if mode == "flip":
        # A wrong reward should be visibly different from the model's score,
        # including the common zero-score case.
        return -value if abs(value) > 1e-9 else 1.0
    if mode == "random":
        return 1.0 if index % 2 == 0 else -1.0
    raise ValueError(f"未知 reward 注入模式: {mode}")


def _parse_json_object(content: str) -> Mapping[str, object]:
    """Accept the first JSON object even when a small model appends chatter."""

    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    value, _ = json.JSONDecoder().raw_decode(text)
    if not isinstance(value, Mapping):
        raise TypeError("LLM 输出顶层不是对象")
    return value


class LLMCandidateScorer:
    """Callable candidate scorer with budget, validation and fault injection."""

    def __init__(
        self,
        data: KGData,
        question: QuestionPublic,
        gateway: object,
        *,
        model: str | None = None,
        max_calls: int = 8,
        max_candidates: int = 8,
        corruption: CorruptionMode = "none",
        score_scale: float = 0.5,
    ) -> None:
        if max_calls < 0:
            raise ValueError("max_calls 不能为负")
        if max_candidates <= 0:
            raise ValueError("max_candidates 必须为正")
        if not isfinite(score_scale) or score_scale < 0:
            raise ValueError("score_scale 必须是非负有限数")
        self.data = data
        self.question = question
        self.gateway = gateway
        self.model = model
        self.max_calls = max_calls
        self.max_candidates = max_candidates
        self.corruption = corruption
        self.score_scale = score_scale
        self.usage = LLMUsage()
        self._cache: dict[
            tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]],
            dict[tuple[object, str], float],
        ] = {}
        self._last_status = "unavailable"

    def __call__(
        self,
        state: SearchState,
        candidates: Sequence[tuple[object, str, float]],
    ) -> Mapping[tuple[object, str], float]:
        path = tuple(_entity_id(item) for item in state.path)
        filtered = list(dict.fromkeys(
            (target, relation)
            for target, relation, _weight in candidates
            if _entity_id(target) not in path
        ))[: self.max_candidates]
        if not filtered:
            return {}
        key = (
            path,
            tuple(state.relations),
            tuple(f"{relation}|{_entity_id(target)}" for target, relation in filtered),
        )
        if key in self._cache:
            self.usage.cached_calls += 1
            return self._cache[key]
        if self.usage.calls >= self.max_calls:
            self._last_status = "budget_exhausted"
            return {}

        scores = self._score_group(filtered, path, state.relations)
        self._cache[key] = scores
        return scores

    def _score_group(
        self,
        filtered: list[tuple[object, str]],
        path: tuple[str, ...],
        relations: tuple[str, ...],
    ) -> dict[tuple[object, str], float]:
        if not filtered or self.usage.calls >= self.max_calls:
            return {}
        by_entity = self.data.graph.entity_by_id
        actions: list[KGActionCandidate] = []
        action_to_key: dict[str, tuple[object, str]] = {}
        for index, (target, relation) in enumerate(filtered):
            target_id = _entity_id(target)
            entity = by_entity.get(target_id)
            label = entity.name if entity is not None else target_id
            action_id = f"a{index}"
            actions.append(KGActionCandidate(action_id, relation, label))
            action_to_key[action_id] = (target, relation)

        self.usage.calls += 1
        started = perf_counter()
        options = {"use_cache": True, "max_tokens": 256}
        if self.model:
            options["model"] = self.model
        try:
            evaluation: KGActionEvaluation = self.gateway.evaluate_kg_actions(
                self.question.prompt,
                tuple(
                    by_entity[entity].name if entity in by_entity else entity
                    for entity in path
                ),
                relations,
                tuple(actions),
                **options,
            )
            self.usage.elapsed_seconds += perf_counter() - started
            self._last_status = evaluation.status
            if evaluation.status == "ok" and len(evaluation.scores) == len(actions):
                scores: dict[tuple[object, str], float] = {}
                for index, row in enumerate(evaluation.scores):
                    reward = float(row.reward)
                    if not isfinite(reward):
                        continue
                    result_key = action_to_key.get(row.action_id)
                    if result_key is None:
                        continue
                    scores[result_key] = _corrupt(reward, self.corruption, index)
                if len(scores) == len(actions):
                    self.usage.ok_calls += 1
                    self.usage.scored_actions += len(scores)
                    return scores
            self.usage.degraded_calls += 1
            if evaluation.error:
                self.usage.errors += (evaluation.error,)
        except Exception as exc:  # noqa: BLE001 - 端点异常必须降级而不是中断搜索
            self.usage.elapsed_seconds += perf_counter() - started
            self.usage.degraded_calls += 1
            self.usage.errors += (f"{type(exc).__name__}: {exc}",)
            self._last_status = "degraded"
            return {}

        # Small local models often answer a shorter JSON list than requested.
        # Split the batch and retry; each sub-batch still goes through the same
        # local validation and count budget.
        if len(filtered) > 1 and self.usage.calls < self.max_calls:
            middle = len(filtered) // 2
            left = self._score_group(filtered[:middle], path, relations)
            right = self._score_group(filtered[middle:], path, relations)
            return {**left, **right}
        return {}

    @property
    def last_status(self) -> str:
        return self._last_status


class LLMRankingScorer:
    """Ask the model to select one candidate; convert the choice to a reward.

    This single-choice protocol is much more robust for small local models than
    asking for a complete JSON list of scores.  The model still sees only the
    public question, current path and candidate actions; the local A* owns the
    final path validity.
    """

    def __init__(
        self,
        data: KGData,
        question: QuestionPublic,
        gateway: object,
        *,
        model: str | None = None,
        max_calls: int = 8,
        max_candidates: int = 8,
        corruption: CorruptionMode = "none",
        selected_reward: float = 0.5,
        other_reward: float = -0.5,
        use_cache: bool = True,
    ) -> None:
        if max_calls < 0 or max_candidates <= 0:
            raise ValueError("LLM 预算无效")
        self.data = data
        self.question = question
        self.gateway = gateway
        self.model = model
        self.max_calls = max_calls
        self.max_candidates = max_candidates
        self.corruption = corruption
        self.selected_reward = selected_reward
        self.other_reward = other_reward
        self.use_cache = use_cache
        self.score_scale = 0.5
        self.usage = LLMUsage()
        self._cache: dict[
            tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]],
            dict[tuple[object, str], float],
        ] = {}
        self._last_status = "unavailable"

    def __call__(
        self,
        state: SearchState,
        candidates: Sequence[tuple[object, str, float]],
    ) -> Mapping[tuple[object, str], float]:
        path = tuple(_entity_id(item) for item in state.path)
        filtered = list(dict.fromkeys(
            (target, relation)
            for target, relation, _weight in candidates
            if _entity_id(target) not in path
        ))[: self.max_candidates]
        if not filtered:
            return {}
        key = (
            path,
            tuple(state.relations),
            tuple(f"{relation}|{_entity_id(target)}" for target, relation in filtered),
        )
        if key in self._cache:
            self.usage.cached_calls += 1
            return self._cache[key]
        if self.usage.calls >= self.max_calls:
            self._last_status = "budget_exhausted"
            return {}

        by_entity = self.data.graph.entity_by_id
        rows = [
            {
                "action_id": f"a{index}",
                "relation": relation,
                "target_label": (
                    by_entity[_entity_id(target)].name
                    if _entity_id(target) in by_entity
                    else _entity_id(target)
                ),
            }
            for index, (target, relation) in enumerate(filtered)
        ]
        prompt = (
            f"问题：{self.question.prompt}\n"
            f"当前路径：{' -> '.join(path)}\n"
            "候选动作如下。只能从 action_id 中选择一个，只返回 "
            '{"action_id":"..."}，不要解释。\n'
            + json.dumps(rows, ensure_ascii=False)
        )
        self.usage.calls += 1
        started = perf_counter()
        try:
            options = {
                "model": self.model,
                "temperature": 0.0,
                "max_tokens": 80,
                "response_format": {"type": "json_object"},
                "use_cache": self.use_cache,
            }
            result = self.gateway.chat(
                [
                    {"role": "system", "content": "只返回一个 JSON 对象。"},
                    {"role": "user", "content": prompt},
                ],
                **options,
            )
            self.usage.elapsed_seconds += perf_counter() - started
            self._last_status = result.status
            if result.status not in {"ok", "cached"} or not result.content:
                self.usage.degraded_calls += 1
                if result.error:
                    self.usage.errors += (result.error,)
                self._cache[key] = {}
                return {}
            payload = _parse_json_object(result.content)
            action_id = payload.get("action_id") if isinstance(payload, Mapping) else None
            if action_id not in {row["action_id"] for row in rows}:
                raise ValueError(
                    f"LLM 选择了不存在的 action_id: {action_id!r}; content={result.content[:160]!r}"
                )
            selected_index = int(action_id[1:])
            if self.corruption == "flip":
                # Invert the model's preference: the chosen branch gets the
                # negative reward and all alternatives get the positive one.
                selected_reward = self.other_reward
                other_reward = self.selected_reward
            elif self.corruption == "random":
                selected_reward = self.other_reward
                other_reward = self.selected_reward
            else:
                selected_reward = self.selected_reward
                other_reward = self.other_reward
            scores = {
                (filtered[index][0], row["relation"]): (
                    selected_reward if index == selected_index else other_reward
                )
                for index, row in enumerate(rows)
            }
            self.usage.ok_calls += 1
            self.usage.scored_actions += len(scores)
            self._cache[key] = scores
            return scores
        except Exception as exc:  # noqa: BLE001 - LLM 故障必须降级
            self.usage.elapsed_seconds += perf_counter() - started
            self.usage.degraded_calls += 1
            self.usage.errors += (f"{type(exc).__name__}: {exc}",)
            self._last_status = "degraded"
            self._cache[key] = {}
            return {}

    @property
    def last_status(self) -> str:
        return self._last_status


def run_llm_astar(
    data: KGData,
    question: QuestionPublic,
    gateway: object,
    *,
    max_expansions: int = 128,
    max_candidate_checks: int | None = 2048,
    max_llm_calls: int = 8,
    max_llm_candidates: int = 8,
    corruption: CorruptionMode = "none",
    model: str | None = None,
    scorer_mode: str = "ranking",
    use_cache: bool = True,
) -> LLMSearchResult:
    """Run LLM-A* on every target depth in one multi-hop question."""

    scorer_cls = LLMRankingScorer if scorer_mode == "ranking" else LLMCandidateScorer
    scorer_options = {
        "max_calls": max_llm_calls,
        "max_candidates": max_llm_candidates,
        "corruption": corruption,
        "model": model,
    }
    if scorer_cls is LLMRankingScorer:
        scorer_options["use_cache"] = use_cache
    scorer = scorer_cls(data, question, gateway, **scorer_options)
    started = perf_counter()
    paths: set[tuple[str, ...]] = set()
    expanded = checks = steps = redundant = 0
    stop_reasons: list[str] = []
    for target_hops in range(question.min_hops, question.max_hops + 1):
        problem = _question_problem(data.graph, question, target_hops)
        config = SearchConfig(
            max_expansions=max_expansions,
            max_candidate_checks=max_candidate_checks,
            max_solutions=1,
            max_depth=target_hops,
            mcts_simulations=0,
            rollout_depth=0,
            seed=20261118,
        )
        result = astar(
            problem,
            lambda state, target=target_hops: float(max(0, target - state.depth)),
            config,
            candidate_scorer=scorer,
            candidate_score_weight=scorer.score_scale,
        )
        paths.update(tuple(_entity_id(node) for node in path) for path in result.solutions)
        expanded += len(result.expanded_nodes)
        checks += result.candidate_checks
        steps += result.reasoning_steps
        redundant += result.redundant_paths
        stop_reasons.append(result.stop_reason)
    if paths and "budget_exhausted" not in stop_reasons:
        stop = "goals_found"
    elif "budget_exhausted" in stop_reasons:
        stop = "budget_exhausted"
    else:
        stop = stop_reasons[0] if stop_reasons else "exhausted"
    run = SearchRun(
        tuple(sorted(paths)),
        expanded,
        checks,
        steps,
        redundant,
        perf_counter() - started,
        (stop, *stop_reasons),
    )
    return LLMSearchResult(run, scorer.usage)


__all__ = [
    "CorruptionMode",
    "LLMCandidateScorer",
    "LLMSearchResult",
    "LLMUsage",
    "run_llm_astar",
]
