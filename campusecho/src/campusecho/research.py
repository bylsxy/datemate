"""正式受控模拟实验；真值仅在评测器中读取，所有置信区间按轨迹重采样。"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import platform
import random
import shutil
import sys
from bisect import bisect_right
from collections import OrderedDict, defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from time import perf_counter

import numpy as np

from .bayes import BayesResult, LocationBayes
from .data import TIME_OF_DAY, WEATHER, generate_dataset, load_cases, write_dataset
from .evidence import CompleteConflictError, conjunctive_combine
from .learned import LearnedLocationModel, prepare_evidence
from .world import FRAME

METHODS = (
    "rule",
    "bayes",
    "strong_bayes",
    "standard_ds",
    "dedup_ds",
    "discount_ds",
    "yager",
    "hybrid",
)
STRATEGIES = ("rule", "bayes", "strong_bayes", "hybrid", "active")
PROTOCOL_VERSION = 1


def _json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def _hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _stable_seed(*parts):
    return int.from_bytes(hashlib.sha256(repr(parts).encode()).digest()[:8], "big")


class FiniteStateAdapter:
    """与公开 learned CPD 精确等价的有限星型网络消元及有限状态缓存。

    缓存键仅有上下文、来源、age 分箱、支持集；不含真值或 case/episode ID。
    missing 输入不观测 report，保持边缘化。完整 API 可直接用于 policy.choose_action。
    """

    def __init__(self, model: LearnedLocationModel, *, cache_size=8192):
        self.model = model
        self.parameters = model.export_parameters()
        self.frame, self.sources = tuple(model.frame), tuple(model.sources)
        self.age_bins, self.alpha = tuple(model.age_bins), model.alpha
        self.training_id = model.training_id
        self.cache_size = cache_size
        self._cache = OrderedDict()
        self.hits = self.misses = 0
        self._location = np.asarray(self.parameters["location_cpd"], dtype=float)
        self._reports = {
            s: np.asarray(p, dtype=float) for s, p in self.parameters["report_cpds"].items()
        }

    def source_reliability(self, source, age=0):
        return self.model.source_reliability(source, age)

    def report_distribution(self, location, source, age=0, context=None):
        return self.model.report_distribution(location, source, age, context)

    def export_parameters(self):
        return self.model.export_parameters()

    def infer(self, evidence, now, context=None):
        # 沿用正式模型的输入验证、可见性/来源去重契约。
        prepared = prepare_evidence(evidence, now, frame=self.frame)
        context = dict(context or {})
        if set(context) - {"time_of_day", "weather"}:
            raise ValueError("context 只能包含 time_of_day/weather")
        if (
            "time_of_day" in context
            and context["time_of_day"] not in TIME_OF_DAY
            or "weather" in context
            and context["weather"] not in WEATHER
        ):
            raise ValueError("未知 context")
        channels = []
        for item in prepared.selected:
            if (
                item.source_id in self.sources
                and item.support is not None
                and item.support != frozenset(self.frame)
                and item.reliability > 0
            ):
                channels.append(
                    (
                        item.source_id,
                        bisect_right(self.age_bins, now - item.observed_at),
                        tuple(sorted(item.support)),
                    )
                )
        key = (tuple(sorted(context.items())), tuple(channels))
        if key in self._cache:
            self.hits += 1
            probs = self._cache.pop(key)
            self._cache[key] = probs
        else:
            self.misses += 1
            t = np.asarray(self.parameters["time_prior"], dtype=float)
            w = np.asarray(self.parameters["weather_prior"], dtype=float)
            if "time_of_day" in context:
                t = np.eye(len(t))[TIME_OF_DAY.index(context["time_of_day"])]
            if "weather" in context:
                w = np.eye(len(w))[WEATHER.index(context["weather"])]
            probs = np.einsum("ltw,t,w->l", self._location, t, w)
            for source, age, support in channels:
                likelihood = self._reports[source][
                    [self.frame.index(s) for s in support], :, age
                ].sum(0)
                probs = probs * likelihood
                probs /= probs.sum()  # 每步缩放不改变条件后验，避免长乘积下溢。
            probs = probs / probs.sum()
            probs = tuple(float(p) for p in probs)
            self._cache[key] = probs
            if len(self._cache) > self.cache_size:
                self._cache.popitem(last=False)
        return BayesResult(
            dict(zip(self.frame, probs)),
            tuple(e.evidence_id for e in prepared.selected),
            {
                "engine": "exact_finite_CPD_elimination",
                "training_id": self.training_id,
                "status": "conditioned" if channels else "context_prior",
                "cache_hits": self.hits,
                "cache_misses": self.misses,
            },
        )


@dataclass(frozen=True)
class ResearchConfig:
    seed: int = 20261103
    train_episodes: int = 3000
    val_episodes: int = 1000
    test_episodes: int = 1000
    snapshots: int = 3
    calibration_episodes: int = 120
    robustness_episodes: int = 150
    sensitivity_episodes: int = 100
    dynamic_episodes: int = 100
    bootstrap: int = 500
    dynamic_max_steps: int = 64
    dynamic_scenario: str = "challenge"


def episode_subset(cases, count):
    """固定 ID 顺序选择完整轨迹；绝不拆散快照。"""
    ids = set(sorted({c.episode_id for c in cases})[:count])
    return tuple(c for c in cases if c.episode_id in ids)


def _original_bayes(evidence, now, frame, *, prior=None, tau=20):
    # 与 LocationBayes 的条件独立 simple-support 通道等价。
    prior = prior or dict.fromkeys(frame, 1 / len(frame))
    logp = np.log([max(prior[s], 1e-300) for s in frame])
    for e in evidence:
        if e.support is None or e.support == frozenset(frame) or e.reliability == 0:
            continue
        r = e.reliability * math.exp(-(now - e.observed_at) / tau)
        likelihood = [
            (r / len(e.support) if s in e.support else 0) + (1 - r) / len(frame) for s in frame
        ]
        logp += np.log(np.maximum(likelihood, 1e-300))
    p = np.exp(logp - logp.max())
    return dict(zip(frame, (p / p.sum()).tolist()))


def _ds(evidence, frame, model=None, now=0, *, yager=False, discount_scale=1):
    adjusted = []
    for e in evidence:
        if model is None:
            reliability = e.reliability * math.exp(-(now - e.observed_at) / 20)
        elif e.source_id in model.sources:
            reliability = model.source_reliability(e.source_id, now - e.observed_at)
        else:
            reliability = e.reliability * math.exp(-(now - e.observed_at) / 20)
        adjusted.append(replace(e, reliability=min(1, max(0, reliability * discount_scale))))
    combined = conjunctive_combine((e.to_mass(frame) for e in adjusted), frame=frame)
    try:
        mass = combined.yager() if yager else combined.dempster()
        return mass.pignistic(), combined.conflict, "ok"
    except CompleteConflictError:
        return dict.fromkeys(frame, 1 / len(frame)), 1.0, "complete_conflict"


def predict(case, method, model, selected, *, raw=False, prior=None):
    evidence, now, context = case.inference_inputs()
    prepared = prepare_evidence(evidence, now)
    records = prepared.selected
    frame = tuple(sorted(FRAME))
    conflict, status = 0.0, "ok"
    abstain = False
    if method == "rule":
        usable = [e for e in records if e.support and e.reliability > 0]
        last = max(
            usable, key=lambda e: (e.observed_at, e.received_at, e.evidence_id), default=None
        )
        abstain = last is None or len(last.support) != 1
        probs = {s: float(last is not None and last.support == {s}) for s in frame}
        if abstain:
            probs = dict.fromkeys(frame, 1 / len(frame))
    elif method == "bayes":
        probs = _original_bayes(records, now, frame, prior=prior)
    elif method in {"strong_bayes", "hybrid", "counterfactual"}:
        probs = model.infer(records, now, context).probabilities
        if method != "strong_bayes":
            _, conflict, status = _ds(
                records, frame, model, now, discount_scale=selected["discount_scale"]
            )
            abstain = (
                max(probs.values()) < selected["confidence_threshold"]
                or conflict > selected["conflict_threshold"]
            )
    else:
        # 主实验标准/去重 DS 故意共享完全相同的输入。raw 只用于独立消融。
        if raw:
            latest_origins = {e.origin_id for e in records}
            records = tuple(
                e
                for e in evidence
                if e.origin_id in latest_origins and e.received_at <= now and e.observed_at <= now
            )
        probs, conflict, status = _ds(
            records,
            frame,
            None if method in {"standard_ds", "dedup_ds", "raw_ds"} else model,
            now,
            yager=method == "yager",
            discount_scale=selected["discount_scale"],
        )
        abstain = status == "complete_conflict"
    prediction = None if abstain else min(frame, key=lambda s: (-probs[s], s))
    return probs, prediction, conflict, status, prepared


def evaluate(
    cases, methods, model, selected, *, experiment, condition, output=None, raw=False, prior=None
):
    rows = []
    for case in cases:
        for method in methods:
            start = perf_counter()
            probs, prediction, conflict, status, prepared = predict(
                case, method, model, selected, raw=raw, prior=prior
            )
            elapsed = (perf_counter() - start) * 1000
            row = {
                "experiment": experiment,
                "condition": str(condition),
                "method": method,
                "case_id": case.case_id,
                "episode_id": case.episode_id,
                "regime": case.regime,
                "truth": case.truth,
                "prediction": prediction,
                "probabilities": probs,
                "correct": prediction == case.truth,
                "covered": prediction is not None,
                "brier": sum((p - float(s == case.truth)) ** 2 for s, p in probs.items()),
                "conflict": conflict,
                "status": status,
                "latency_ms": elapsed,
                "input_evidence": len(case.evidence),
                "selected_evidence": len(prepared.selected),
                "selected_ids": [e.evidence_id for e in prepared.selected],
            }
            rows.append(row)
            if output is not None:
                output.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
    return rows


def summarize(rows, *, bootstrap=500, seed=20261103):
    """episode cluster bootstrap；MacroF1 把拒答当该真实类的 FN。"""
    if not rows:
        return {}
    frame = tuple(sorted(FRAME))
    episodes = sorted({r["episode_id"] for r in rows})
    index = {e: i for i, e in enumerate(episodes)}
    k = len(frame)
    stats = np.zeros((len(episodes), 4 + k * (k + 1)))
    for r in rows:
        i = index[r["episode_id"]]
        stats[i, :4] += (1, r["correct"], r["brier"], r["covered"])
        col = k if r["prediction"] is None else frame.index(r["prediction"])
        stats[i, 4 + frame.index(r["truth"]) * (k + 1) + col] += 1

    def metrics(totals):
        n, correct, brier, covered = (totals[..., i] for i in range(4))
        conf = totals[..., 4:].reshape(*totals.shape[:-1], k, k + 1)
        tp = np.diagonal(conf[..., :, :k], axis1=-2, axis2=-1)
        denom = conf.sum(-1) + conf[..., :, :k].sum(-2)
        f1 = np.divide(2 * tp, denom, out=np.zeros_like(tp), where=denom > 0).mean(-1)
        risk = np.divide(
            covered - correct, covered, out=np.full_like(covered, np.nan), where=covered > 0
        )
        return {
            "accuracy": correct / n,
            "macro_f1": f1,
            "brier": brier / n,
            "coverage": covered / n,
            "selective_risk": risk,
            "decision_loss": ((covered - correct) + 0.35 * (n - covered)) / n,
        }

    point = metrics(stats.sum(0))
    rng = np.random.default_rng(seed)
    weights = rng.multinomial(
        len(episodes), np.full(len(episodes), 1 / len(episodes)), size=bootstrap
    )
    draws = metrics(weights @ stats)
    result = {
        "snapshots": len(rows),
        "episodes": len(episodes),
        "bootstrap_unit": "episode",
        "bootstrap_replicates": bootstrap,
    }
    for metric, value in point.items():
        result[metric] = float(value) if np.isfinite(value) else None
        values = draws[metric]
        values = values[np.isfinite(values)]
        result[metric + "_ci95"] = (
            np.quantile(values, [0.025, 0.975]).tolist() if len(values) else None
        )
    latency = np.array([r["latency_ms"] for r in rows])
    result["latency_p50_ms"], result["latency_p95_ms"] = np.quantile(latency, [0.5, 0.95]).tolist()
    result["abstentions"] = sum(not r["covered"] for r in rows)
    return result


def summarize_groups(rows, config):
    groups = defaultdict(list)
    for r in rows:
        groups[(r["experiment"], r["condition"], r["method"])].append(r)
    return [
        {
            "experiment": e,
            "condition": c,
            "method": m,
            **summarize(rs, bootstrap=config.bootstrap, seed=config.seed),
        }
        for (e, c, m), rs in sorted(groups.items())
    ]


def paired_comparisons(rows, config, reference="strong_bayes"):
    """同一 episode 同一重采样权重；输出参考模型减基线的差。"""
    models = defaultdict(dict)
    for r in rows:
        models[r["method"]][r["case_id"]] = r
    result = []
    for method in sorted(models):
        if method == reference:
            continue
        ids = sorted(set(models[reference]) & set(models[method]))
        groups = defaultdict(list)
        for key in ids:
            left, right = models[reference][key], models[method][key]
            groups[left["episode_id"]].append(
                [float(left["correct"]) - float(right["correct"]), left["brier"] - right["brier"]]
            )
        differences = np.asarray([np.mean(v, axis=0) for _, v in sorted(groups.items())])
        rng = np.random.default_rng(config.seed)
        draws = differences[
            rng.integers(len(differences), size=(config.bootstrap, len(differences)))
        ].mean(1)
        result.append(
            {
                "reference": reference,
                "method": method,
                "episodes": len(groups),
                "snapshots": len(ids),
                "accuracy_difference": float(differences[:, 0].mean()),
                "accuracy_difference_ci95": np.quantile(draws[:, 0], [0.025, 0.975]).tolist(),
                "brier_difference": float(differences[:, 1].mean()),
                "brier_difference_ci95": np.quantile(draws[:, 1], [0.025, 0.975]).tolist(),
            }
        )
    return result


def calibrate(dataset, config, root):
    calibration = episode_subset(dataset["val"], config.calibration_episodes)
    candidates, best = [], None
    defaults = {"discount_scale": 1.0, "confidence_threshold": 0.55, "conflict_threshold": 0.6}
    for alpha in (0.3, 1.0, 3.0):
        for bins in ((5.0, 15.0), (3.0, 10.0, 25.0)):
            model = FiniteStateAdapter(
                LearnedLocationModel.fit(dataset["train"], alpha=alpha, age_bins=bins)
            )
            rows = evaluate(
                calibration,
                ["strong_bayes"],
                model,
                defaults,
                experiment="calibration_model",
                condition=f"alpha={alpha};bins={bins}",
            )
            score = sum(r["brier"] for r in rows) / len(rows)
            candidates.append(
                {
                    "alpha": alpha,
                    "age_bins": list(bins),
                    "brier": score,
                    "episodes": len({c.episode_id for c in calibration}),
                    "snapshots": len(rows),
                }
            )
            if best is None or score < best[0]:
                best = (score, model)
    model = best[1]
    grid = []
    # 只在校准子集选择 DS 折扣及拒答阈值；代价在观察 val 前固定。
    for scale in (0.7, 1.0):
        base = {**defaults, "discount_scale": scale}
        base_rows = evaluate(
            calibration, ["hybrid"], model, base, experiment="calibration_policy", condition=scale
        )
        for confidence in (0.4, 0.55, 0.7):
            for conflict in (0.35, 0.6, 0.85):
                loss = 0
                for r in base_rows:
                    abstain = (
                        max(r["probabilities"].values()) < confidence or r["conflict"] > conflict
                    )
                    choice = min(r["probabilities"], key=lambda s: (-r["probabilities"][s], s))
                    loss += 0.35 if abstain else float(choice != r["truth"])
                grid.append(
                    {
                        "discount_scale": scale,
                        "confidence_threshold": confidence,
                        "conflict_threshold": conflict,
                        "decision_loss": loss / len(base_rows),
                    }
                )
    chosen = min(
        grid,
        key=lambda r: (r["decision_loss"], r["confidence_threshold"], -r["conflict_threshold"]),
    )
    selected = {k: chosen[k] for k in defaults}
    model.model.save(root / "model.json")
    from .policy import PolicyConfig

    policy = asdict(
        PolicyConfig(
            confidence_threshold=selected["confidence_threshold"],
            conflict_threshold=selected["conflict_threshold"],
        )
    )
    _json(root / "policy_config.json", policy)
    selection = {
        "model_grid": candidates,
        "policy_grid": grid,
        "selected": selected,
        "alpha": model.alpha,
        "age_bins": list(model.age_bins),
        "criterion": "minimum multiclass Brier; policy minimum wrong=1/abstain=.35 loss",
        "calibration_episodes": len({c.episode_id for c in calibration}),
        "calibration_snapshots": len(calibration),
        "test_labels_used": False,
        "full_val_evaluated_after_selection": True,
        "not_optimized": "query cost and dynamic policy outcomes; query_cost fixed before test",
    }
    _json(root / "selection.json", selection)
    return model, selected, selection


def perturb(cases, kind, value, seed):
    result = []
    frame = tuple(sorted(FRAME))
    for case in cases:
        records = []
        # 同一证据 origin 在快照和同一压力轴间共享随机数，重复件保持原载荷。
        for e in case.evidence:
            rng = random.Random(_stable_seed(seed, kind, e.origin_id))
            u = rng.random()
            support = e.support
            observed_at = e.observed_at
            if kind == "noise" and support and u < value:
                alternatives = [s for s in frame if s not in support]
                support = (
                    frozenset({alternatives[int(u * 100000) % len(alternatives)]})
                    if alternatives
                    else support
                )
            elif kind == "missing" and u < value:
                support = None
            elif kind == "age":
                observed_at -= value
            records.append(replace(e, support=support, observed_at=observed_at))
        if kind == "copy":
            prepared = prepare_evidence(records, case.now)
            records = list(prepared.selected)
            for e in prepared.selected:
                for copy in range(int(value) - 1):
                    records.append(
                        replace(
                            e,
                            evidence_id=f"{e.evidence_id}:stress{copy}",
                            source_id=f"relay-stress-{copy}",
                        )
                    )
        result.append(replace(case, evidence=tuple(records)))
    return tuple(result)


def verify_adapter(model, cases, count=24):
    errors = []
    timings = {"finite_ms": [], "pgmpy_ms": []}
    for case in cases[:count]:
        evidence, now, context = case.inference_inputs()
        start = perf_counter()
        fast = model.infer(evidence, now, context)
        timings["finite_ms"].append((perf_counter() - start) * 1000)
        start = perf_counter()
        exact = model.model.infer(evidence, now, context)
        timings["pgmpy_ms"].append((perf_counter() - start) * 1000)
        errors.append(max(abs(fast.probabilities[s] - exact.probabilities[s]) for s in model.frame))
    # 包含无上下文、集合事件、全部缺失；正式缺失语义同样受检。
    for context in ({}, {"weather": "rain"}):
        fast = model.infer((), 0, context).probabilities
        exact = model.model.infer((), 0, context).probabilities
        errors.append(max(abs(fast[s] - exact[s]) for s in model.frame))
    max_error = max(errors)
    if max_error > 1e-10:
        raise AssertionError(f"有限状态推理与 pgmpy 不一致: {max_error}")
    baseline_errors = []
    for case in cases[:8]:
        records = prepare_evidence(case.evidence, case.now).selected
        fast = _original_bayes(records, case.now, model.frame)
        exact = LocationBayes(model.frame, tau=20).infer(records, case.now).probabilities
        baseline_errors.append(max(abs(fast[s] - exact[s]) for s in model.frame))
    if max(baseline_errors, default=0) > 1e-10:
        raise AssertionError("原 Bayes 快速计算不等价")
    return {
        "passed": True,
        "learned_queries": len(errors),
        "learned_max_absolute_error": max_error,
        "original_bayes_queries": len(baseline_errors),
        "original_max_absolute_error": max(baseline_errors),
        "timing_ms": {
            k: {"p50": float(np.median(v)), "p95": float(np.quantile(v, 0.95))}
            for k, v in timings.items()
        },
    }


def rule_benchmarks(root):
    from .engine import campus_rules, facts_from_view
    from .logic import Atom, Rule, Var, forward_chain
    from .world import observe, scenario

    x = Var("x")
    fixtures = [
        (
            "campus",
            "actual",
            facts_from_view(observe(scenario("mission", 17), "player")),
            campus_rules(),
        )
    ]
    for n in (100, 1000, 10000):
        fixtures.append(
            (
                "synthetic_facts",
                str(n),
                {Atom("Signal", (i,)) for i in range(12)}
                | {Atom("Distractor", (i,)) for i in range(n - 12)},
                (
                    Rule("seen", Atom("Seen", (x,)), (Atom("Signal", (x,)),)),
                    Rule("known", Atom("Known", (x,)), (Atom("Seen", (x,)),)),
                ),
            )
        )
        fixtures.append(
            (
                "synthetic_rules",
                str(n),
                {Atom("Signal", (1,))},
                tuple(
                    Rule(
                        f"rule-{i}",
                        Atom(f"Result{i}", (x,)),
                        (Atom("Signal" if i < 12 else f"Absent{i}", (x,)),),
                    )
                    for i in range(n)
                ),
            )
        )
    rows = []
    for kind, size, facts, rules in fixtures:
        outputs = {}
        for repeat in range(3):
            for method in ("naive", "semi_naive"):
                result = forward_chain(facts, rules, method=method)
                outputs[method] = result.facts
                rows.append(
                    {
                        "experiment": kind,
                        "size": size,
                        "repeat": repeat,
                        "method": method,
                        "rules": len(rules),
                        "facts": len(facts),
                        **result.metrics.as_dict(),
                        "closure_sha256": hashlib.sha256(
                            repr(sorted((a.predicate, repr(a.args)) for a in result.facts)).encode()
                        ).hexdigest(),
                    }
                )
            if outputs["naive"] != outputs["semi_naive"]:
                raise AssertionError("优化前后规则闭包不一致")
    with (root / "rule_raw.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    return {
        "closure_equal_all": True,
        "repeats": 3,
        "rows": rows,
        "interpretation": "actual campus workload and synthetic fact/rule pressure are separate",
    }


def dynamic_experiment(model, selected, config, root):
    from .policy import DISTANCES, PolicyConfig, choose_action
    from .world import Action, legal_actions, observe, scenario, step

    policy = PolicyConfig(
        confidence_threshold=selected["confidence_threshold"],
        conflict_threshold=selected["conflict_threshold"],
    )
    rows = []
    with (root / "dynamic_actions.jsonl").open("w", encoding="utf-8") as actions_file:
        for i in range(config.dynamic_episodes):
            seed = config.seed + 100000 + i
            initial = scenario(config.dynamic_scenario, seed)
            initial_hash = hashlib.sha256(initial.to_json().encode()).hexdigest()
            scenario_hash = hashlib.sha256(repr(initial.schedules).encode()).hexdigest()
            for strategy in STRATEGIES:
                world = initial
                steps = walked = queries = violations = 0
                inference_seconds = 0.0
                error = None
                failed_action = None
                failure_legal_actions = None
                while world.task.status == "active" and steps < config.dynamic_max_steps:
                    view = observe(world, "player")
                    start = perf_counter()
                    decision = choose_action(view, model, strategy=strategy, config=policy)
                    inference_seconds += perf_counter() - start
                    action = decision.action or Action("wait", "player", minutes=1)
                    if action not in legal_actions(view):
                        violations += 1
                        error = "policy produced illegal action"
                        failed_action = asdict(action)
                        failure_legal_actions = [asdict(a) for a in legal_actions(view)]
                        break
                    before_tick = world.tick
                    try:
                        updated = step(world, action)
                    except (ValueError, KeyError) as exc:
                        violations += 1
                        error = f"{type(exc).__name__}: {exc}"
                        failed_action = asdict(action)
                        failure_legal_actions = [asdict(a) for a in legal_actions(view)]
                        break
                    actions_file.write(
                        json.dumps(
                            {
                                "episode_id": str(seed),
                                "strategy": strategy,
                                "step": steps,
                                "tick": before_tick,
                                "location": view.location,
                                "action": asdict(action),
                                "reason": decision.reason,
                                "information_value": decision.information_value,
                                "evidence_ids": [
                                    e.evidence_id for e in view.evidence_for(view.task.target)
                                ],
                                "status_after": updated.task.status,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    walked += action.minutes if action.kind == "move" else 0
                    queries += action.kind == "ask"
                    steps += 1
                    world = updated
                    if world.tick <= before_tick:
                        violations += 1
                        error = "non-progressing policy action"
                        break
                rows.append(
                    {
                        "episode_id": str(seed),
                        "seed": seed,
                        "strategy": strategy,
                        "initial_world_sha256": initial_hash,
                        "external_schedule_sha256": scenario_hash,
                        "status": world.task.status,
                        "success": world.task.status == "success",
                        "rescheduled": world.task.status == "rescheduled",
                        "missed": world.task.status == "missed",
                        "steps": steps,
                        "travel_minutes": walked,
                        "extra_distance_minutes": max(
                            0, walked - DISTANCES[observe(initial, "player").location]["venue"]
                        ),
                        "queries": queries,
                        "query_time_minutes": queries * 2,
                        "query_cost_units": queries * policy.query_cost,
                        "total_time_minutes": world.tick - initial.tick,
                        "decision_wall_seconds": inference_seconds,
                        "constraint_violations": violations,
                        "error": error,
                        "failed_action": failed_action,
                        "failure_legal_actions": failure_legal_actions,
                    }
                )
            if (i + 1) % 20 == 0:
                print(f"dynamic {i + 1}/{config.dynamic_episodes} paired episodes", flush=True)
    with (root / "dynamic_raw.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    summaries = []
    keys = (
        "success",
        "rescheduled",
        "missed",
        "steps",
        "extra_distance_minutes",
        "queries",
        "total_time_minutes",
        "constraint_violations",
        "query_time_minutes",
        "query_cost_units",
    )
    for strategy in STRATEGIES:
        subset = [r for r in rows if r["strategy"] == strategy]
        values = np.asarray([[float(r[k]) for k in keys] for r in subset])
        rng = np.random.default_rng(config.seed)
        draws = values[rng.integers(len(values), size=(config.bootstrap, len(values)))].mean(1)
        summary = {"strategy": strategy, "episodes": len(subset)}
        for j, k in enumerate(keys):
            summary[k] = float(values[:, j].mean())
            summary[k + "_ci95"] = np.quantile(draws[:, j], [0.025, 0.975]).tolist()
        summary["unfinished"] = sum(r["status"] == "active" for r in subset)
        summaries.append(summary)
    differences = []
    by = {(r["episode_id"], r["strategy"]): r for r in rows}
    for strategy in STRATEGIES[:-1]:
        diffs = np.array(
            [
                float(by[(str(config.seed + 100000 + i), "active")]["success"])
                - float(by[(str(config.seed + 100000 + i), strategy)]["success"])
                for i in range(config.dynamic_episodes)
            ]
        )
        rng = np.random.default_rng(config.seed)
        draws = diffs[rng.integers(len(diffs), size=(config.bootstrap, len(diffs)))].mean(1)
        differences.append(
            {
                "reference": "active",
                "strategy": strategy,
                "episodes": len(diffs),
                "success_difference": float(diffs.mean()),
                "success_difference_ci95": np.quantile(draws, [0.025, 0.975]).tolist(),
            }
        )
    return {
        "summary": summaries,
        "paired_success_differences": differences,
        "paired_same_initial_world": True,
        "policy_receives": "AgentView only; truth used only by evaluator",
        "query_cost": "2 simulated minutes per query plus PolicyConfig.query_cost in VOI objective",
        "extra_distance_definition": "walked minutes above shortest initial player-to-venue route",
        "external_schedule_variants": len({r["external_schedule_sha256"] for r in rows}),
        "scenario": config.dynamic_scenario,
        "scope_limit": "Controlled six-place campus challenge family; seeds are paired across strategies, not different real campuses",
        "all_failed_strategies": [s["strategy"] for s in summaries if s["success"] == 0],
        "constraint_violations_total": sum(r["constraint_violations"] for r in rows),
    }


def _csv(path, rows):
    if not rows:
        return
    normalized = []
    for row in rows:
        item = {}
        for key, value in row.items():
            if key.endswith("_ci95") and (value is None or len(value) == 2):
                item[key + "_low"] = None if value is None else value[0]
                item[key + "_high"] = None if value is None else value[1]
            else:
                item[key] = value
        normalized.append(item)
    rows = normalized
    columns = list(dict.fromkeys(k for row in rows for k in row))
    with Path(path).open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v
                    for k, v in row.items()
                }
            )


def plots(root, summary):
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "font.size": 10,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "figure.dpi": 140,
            "savefig.bbox": "tight",
        }
    )
    out = root / "figures"
    out.mkdir(exist_ok=True)
    paths = []

    def save(fig, name):
        for suffix in ("png", "svg"):
            path = out / f"{name}.{suffix}"
            fig.savefig(path)
            paths.append(str(path.relative_to(root)))
        plt.close(fig)

    def errors(rows, key):
        return np.array(
            [
                [max(0, r[key] - r[key + "_ci95"][0]), max(0, r[key + "_ci95"][1] - r[key])]
                for r in rows
            ]
        ).T

    static = [
        r for r in summary["results"] if r["experiment"] == "static" and r["condition"] == "test"
    ]
    static = sorted(static, key=lambda r: METHODS.index(r["method"]))
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.5))
    for ax, key in zip(axes, ("accuracy", "brier")):
        ax.bar(range(len(static)), [r[key] for r in static], yerr=errors(static, key), capsize=3)
        ax.set_xticks(range(len(static)), [r["method"] for r in static], rotation=40, ha="right")
        ax.set_ylabel(key)
        ax.grid(axis="y", alpha=0.2)
    fig.suptitle(
        f"Controlled simulation: frozen test; n={static[0]['episodes']} episodes / {static[0]['snapshots']} snapshots; episode-bootstrap 95% CI"
    )
    fig.tight_layout()
    save(fig, "01_static_test")
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    for ax, kind in zip(axes.flat, ("noise", "missing", "copy", "age")):
        for method in ("rule", "strong_bayes", "standard_ds", "discount_ds", "yager", "hybrid"):
            rows = sorted(
                [
                    r
                    for r in summary["results"]
                    if r["experiment"] == kind and r["method"] == method
                ],
                key=lambda r: float(r["condition"]),
            )
            if not rows:
                continue
            xs = [float(r["condition"]) for r in rows]
            ax.errorbar(
                xs,
                [r["accuracy"] for r in rows],
                yerr=errors(rows, "accuracy"),
                marker="o",
                capsize=2,
                label=method,
            )
        ax.set_title(f"{kind}; n={summary['config']['robustness_episodes']} episodes / condition")
        ax.set_xlabel(kind)
        ax.set_ylabel("accuracy (abstain = incorrect)")
        ax.grid(alpha=0.2)
    axes[0, 0].legend(fontsize=8, ncol=2)
    fig.suptitle("Paired perturbations of fixed test trajectories; episode-bootstrap 95% CI")
    fig.tight_layout()
    save(fig, "02_robustness")
    dynamic = summary["dynamic"]["summary"]
    if dynamic:
        fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
        for ax, key in zip(axes, ("success", "total_time_minutes")):
            ax.bar(
                range(len(dynamic)), [r[key] for r in dynamic], yerr=errors(dynamic, key), capsize=3
            )
            ax.set_xticks(
                range(len(dynamic)), [r["strategy"] for r in dynamic], rotation=25, ha="right"
            )
            ax.set_ylabel(key)
            ax.grid(axis="y", alpha=0.2)
        fig.suptitle(
            f"Dynamic challenge: n={summary['config']['dynamic_episodes']} paired seeds / strategy; episode-bootstrap 95% CI"
        )
        fig.tight_layout()
        save(fig, "03_dynamic")
    rule = summary["rules"]["rows"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for ax, kind in zip(axes, ("synthetic_facts", "synthetic_rules")):
        for method in ("naive", "semi_naive"):
            xs, ys, ys_err = [], [], []
            for size in (100, 1000, 10000):
                vals = [
                    r["elapsed_seconds"]
                    for r in rule
                    if r["experiment"] == kind and r["size"] == str(size) and r["method"] == method
                ]
                xs.append(size)
                ys.append(np.median(vals))
                ys_err.append((max(vals) - min(vals)) / 2)
            ax.errorbar(xs, ys, yerr=ys_err, marker="o", capsize=3, label=method)
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xlabel(kind)
        ax.set_ylabel("seconds (median; half-range)")
        ax.legend()
        ax.grid(alpha=0.2)
    fig.suptitle("Synthetic pressure separately from actual campus; 3 repeats; all closures equal")
    fig.tight_layout()
    save(fig, "04_rule_scaling")
    rows = [r for r in summary["results"] if r["experiment"] == "threshold"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    rows = sorted(rows, key=lambda r: float(r["condition"]))
    for ax, key in zip(axes, ("coverage", "selective_risk")):
        valid = [r for r in rows if r[key] is not None]
        ax.errorbar(
            [float(r["condition"]) for r in valid],
            [r[key] for r in valid],
            yerr=errors(valid, key),
            marker="o",
            capsize=3,
        )
        ax.set_xlabel("posterior confidence threshold")
        ax.set_ylabel(key)
        ax.grid(alpha=0.2)
    fig.suptitle(
        f"Selective prediction: n={summary['config']['sensitivity_episodes']} test episodes; 95% episode CI"
    )
    fig.tight_layout()
    save(fig, "05_selective_risk")
    return paths


def run_research(output="artifacts/research", config=None, *, resume=True):
    config = config or ResearchConfig()
    if (
        min(
            config.train_episodes,
            config.val_episodes,
            config.test_episodes,
            config.dynamic_episodes,
            config.bootstrap,
        )
        < 1
    ):
        raise ValueError("正式实验各分割、dynamic 和 bootstrap 数量必须为正")
    root = Path(output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    start = perf_counter()
    phases = {}

    def phase(name, status="running", **detail):
        phases[name] = {"status": status, "elapsed_seconds": perf_counter() - start, **detail}
        _json(root / "phase_status.json", {"status": "running", "phases": phases})
        print(f"[{status}] {name}: {detail}", flush=True)

    phase("dataset")
    dataset_root = root / "dataset"
    if resume and (dataset_root / "manifest.json").exists():
        manifest = json.loads((dataset_root / "manifest.json").read_text(encoding="utf-8"))
        wanted = {
            "train": config.train_episodes,
            "val": config.val_episodes,
            "test": config.test_episodes,
        }
        for split, n in wanted.items():
            meta = manifest["splits"][split]
            if (
                meta["episodes"] != n
                or meta["cases"] != n * config.snapshots
                or _hash(dataset_root / meta["file"]) != meta["sha256"]
            ):
                raise ValueError("已有数据与配置/哈希不符；请使用独立输出目录")
        if manifest["seeds"] != [config.seed]:
            raise ValueError("已有数据 seed 不符")
        dataset = {s: load_cases(dataset_root / f"{s}.jsonl") for s in ("train", "val", "test")}
    else:
        dataset = generate_dataset(
            seed=config.seed,
            train_episodes=config.train_episodes,
            val_episodes=config.val_episodes,
            test_episodes=config.test_episodes,
            snapshots=config.snapshots,
        )
        manifest = write_dataset(dataset_root, dataset)
    phase("dataset", "complete", splits={s: len(cs) for s, cs in dataset.items()})
    phase("calibration")
    model, selected, selection = calibrate(dataset, config, root)
    verification = verify_adapter(model, dataset["val"])
    phase("calibration", "complete", selected=selected, alpha=model.alpha, age_bins=model.age_bins)
    rows = []
    with (root / "predictions.jsonl").open("w", encoding="utf-8") as raw:
        phase("full_validation")
        rows += evaluate(
            dataset["val"],
            METHODS,
            model,
            selected,
            experiment="validation",
            condition="val",
            output=raw,
        )
        phase("full_validation", "complete", snapshots=len(dataset["val"]))
        # 评测 test 之前冻结配置、来源、数据和训练模型哈希。
        sources = {p.name: _hash(p) for p in Path(__file__).parent.glob("*.py")}
        protocol = {
            "schema_version": PROTOCOL_VERSION,
            "frozen_utc": datetime.now(UTC).isoformat(),
            "config": asdict(config),
            "selection": selection,
            "source_sha256": sources,
            "dataset_sha256": {s: m["sha256"] for s, m in manifest["splits"].items()},
            "model_sha256": _hash(root / "model.json"),
            "policy_config_sha256": _hash(root / "policy_config.json"),
            "test_frozen_before_inference": True,
            "bootstrap_unit": "episode",
            "primary_methods": list(METHODS),
            "primary_preprocessing": "shared prepare_evidence for every model",
            "standard_dedup_ds": "identical after shared preprocessing; raw no-dedup only in designated ablation",
            "latency": "single process sequential CPU wall clock; shared prepare included; exact CPD cache warmness recorded by adapter",
            "abstention": "accuracy includes abstention as incorrect; MacroF1 includes FN; Brier uses uniform for no distribution",
            "risk_cost": {"wrong": 1, "abstain": 0.35},
            "data_origin": "controlled campus simulation, not real-world validation",
            "dynamic_protocol": {
                "scenario": config.dynamic_scenario,
                "episodes_per_strategy": config.dynamic_episodes,
                "amendment_before_test": "Use varied challenge initial locations/schedules/evidence ages; mission is teaching replay only",
                "change_reason": "Fixed mission initial location and three departure offsets are insufficient dynamic diversity",
                "frozen_before_any_test_inference": True,
                "deadline_policy": "world-supplied fixed deadline; never relax on failure",
            },
            "sweep_plan": {
                "noise": [0, 0.1, 0.2, 0.3, 0.4],
                "missing": [0, 0.2, 0.4, 0.6],
                "copy": [1, 3, 10],
                "age": [0, 10, 30, 60],
                "prior": ["uniform", "train_global", "train_context"],
                "alpha": [0.1, 0.3, 1, 3, 10],
                "discount": [0.4, 0.7, 1],
                "threshold": [0, 0.3, 0.4, 0.55, 0.7, 0.85, 0.95],
            },
        }
        _json(root / "frozen_protocol.json", protocol)
        phase("static_test")
        static = evaluate(
            dataset["test"],
            METHODS,
            model,
            selected,
            experiment="static",
            condition="test",
            output=raw,
        )
        rows += static
        phase("static_test", "complete", predictions=len(static))
        phase("perturbations")
        subset = episode_subset(dataset["test"], config.robustness_episodes)
        for kind, values in protocol["sweep_plan"].items():
            if kind not in {"noise", "missing", "copy", "age"}:
                continue
            for value in values:
                changed = perturb(subset, kind, value, config.seed)
                rows += evaluate(
                    changed, METHODS, model, selected, experiment=kind, condition=value, output=raw
                )
                if kind == "copy":
                    rows += evaluate(
                        changed,
                        ["raw_ds"],
                        model,
                        selected,
                        experiment="copy_unsafe_raw",
                        condition=value,
                        output=raw,
                        raw=True,
                    )
        phase(
            "perturbations",
            "complete",
            episodes=len({c.episode_id for c in subset}),
            snapshots=len(subset),
        )
        phase("sensitivity_ablation")
        small = episode_subset(dataset["test"], config.sensitivity_episodes)
        for threshold in protocol["sweep_plan"]["threshold"]:
            rows += evaluate(
                small,
                ["hybrid"],
                model,
                {**selected, "confidence_threshold": threshold},
                experiment="threshold",
                condition=threshold,
                output=raw,
            )
        for scale in protocol["sweep_plan"]["discount"]:
            rows += evaluate(
                small,
                ["discount_ds", "yager"],
                model,
                {**selected, "discount_scale": scale},
                experiment="discount",
                condition=scale,
                output=raw,
            )
        for alpha in protocol["sweep_plan"]["alpha"]:
            fitted = FiniteStateAdapter(
                LearnedLocationModel.fit(dataset["train"], alpha=alpha, age_bins=model.age_bins)
            )
            rows += evaluate(
                small,
                ["strong_bayes"],
                fitted,
                selected,
                experiment="smoothing",
                condition=alpha,
                output=raw,
            )
        for bins in ((), (5.0, 15.0), (3.0, 10.0, 25.0)):
            fitted = FiniteStateAdapter(
                LearnedLocationModel.fit(dataset["train"], alpha=model.alpha, age_bins=bins)
            )
            rows += evaluate(
                small,
                ["strong_bayes"],
                fitted,
                selected,
                experiment="age_bins",
                condition=str(bins),
                output=raw,
            )
        params = model.export_parameters()
        global_prior = np.einsum(
            "ltw,t,w->l",
            np.asarray(params["location_cpd"]),
            np.asarray(params["time_prior"]),
            np.asarray(params["weather_prior"]),
        )
        rows += evaluate(
            small, ["bayes"], model, selected, experiment="prior", condition="uniform", output=raw
        )
        rows += evaluate(
            small,
            ["bayes"],
            model,
            selected,
            experiment="prior",
            condition="train_global",
            output=raw,
            prior=dict(zip(model.frame, global_prior)),
        )
        for case in small:
            context_prior = model.infer((), case.now, dict(case.context)).probabilities
            rows += evaluate(
                (case,),
                ["bayes"],
                model,
                selected,
                experiment="prior",
                condition="train_context",
                output=raw,
                prior=context_prior,
            )
        for name, changed in (
            (
                "no_context",
                tuple(
                    replace(c, context={"time_of_day": "morning", "weather": "clear"})
                    for c in small
                ),
            ),
            (
                "no_age",
                tuple(
                    replace(
                        c,
                        evidence=tuple(
                            replace(e, observed_at=c.now, received_at=min(e.received_at, c.now))
                            for e in c.evidence
                        ),
                    )
                    for c in small
                ),
            ),
            (
                "single_source",
                tuple(
                    replace(c, evidence=tuple(e for e in c.evidence if e.source_id == "direct"))
                    for c in small
                ),
            ),
            (
                "all_missing",
                tuple(
                    replace(c, evidence=tuple(replace(e, support=None) for e in c.evidence))
                    for c in small
                ),
            ),
        ):
            if name == "no_context":
                # 合法 DatasetCase 保持 context schema；适配器显式边缘化上下文。
                class WithoutContext:
                    def infer(self, evidence, now, context=None):
                        return model.infer(evidence, now, {})

                use = WithoutContext()
            else:
                use = model
            rows += evaluate(
                changed,
                ["strong_bayes"],
                use,
                selected,
                experiment="ablation",
                condition=name,
                output=raw,
            )
        rows += evaluate(
            small,
            ["hybrid"],
            model,
            {**selected, "confidence_threshold": 0, "conflict_threshold": 1},
            experiment="ablation",
            condition="no_rejection",
            output=raw,
        )
        rows += evaluate(
            small,
            ["raw_ds"],
            model,
            selected,
            experiment="ablation",
            condition="no_dedup",
            output=raw,
            raw=True,
        )
        for source in model.sources:
            dropped = tuple(
                replace(c, evidence=tuple(e for e in c.evidence if e.source_id != source))
                for c in small
            )
            rows += evaluate(
                dropped,
                ["strong_bayes", "hybrid"],
                model,
                selected,
                experiment="counterfactual_drop_source",
                condition=source,
                output=raw,
            )
        phase(
            "sensitivity_ablation",
            "complete",
            episodes=len({c.episode_id for c in small}),
            snapshots=len(small),
        )
    phase("rules")
    rules = rule_benchmarks(root)
    phase("rules", "complete", closure_equal=rules["closure_equal_all"])
    # 正式动态在独立新进程 --resume-dynamic 中执行；避免并行开发的模块热重载
    # 使 Action dataclass 身份改变，并确保只运行用户批准的双源码 hash。
    dynamic = {
        "status": "awaiting_DYNAMIC_APPROVED",
        "summary": [],
        "paired_success_differences": [],
        "constraint_violations_total": None,
    }
    phase("dynamic", "awaiting_DYNAMIC_APPROVED", scenario=config.dynamic_scenario)
    phase("statistics_figures")
    results = summarize_groups(rows, config)
    # 测试分布转移单独报告，避免总平均掩盖难例。
    for regime in sorted({r["regime"] for r in static}):
        for method in METHODS:
            part = [r for r in static if r["regime"] == regime and r["method"] == method]
            results.append(
                {
                    "experiment": "test_regime",
                    "condition": regime,
                    "method": method,
                    **summarize(part, bootstrap=config.bootstrap, seed=config.seed),
                }
            )
    source_end = {p.name: _hash(p) for p in Path(__file__).parent.glob("*.py")}
    formal = (
        config.train_episodes >= 3000
        and config.val_episodes >= 1000
        and config.test_episodes >= 1000
    )
    summary = {
        "schema_version": PROTOCOL_VERSION,
        "status": "static_complete_dynamic_awaiting_approval"
        if formal
        else "nonformal_static_complete_dynamic_awaiting_approval",
        "config": asdict(config),
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            **{k: version(k) for k in ("numpy", "pgmpy", "matplotlib")},
        },
        "selection": selection,
        "verification": verification,
        "results": results,
        "paired_test_differences": paired_comparisons(static, config),
        "dynamic": dynamic,
        "rules": rules,
        "raw_prediction_rows": len(rows),
        "dataset_manifest": "dataset/manifest.json",
        "source_changed_during_test": [k for k in source_end if sources.get(k) != source_end[k]],
        "frozen_protocol_sha256": _hash(root / "frozen_protocol.json"),
        "findings": {
            "standard_ds_equals_dedup_ds": all(
                a["probabilities"] == b["probabilities"]
                for a, b in zip(
                    [r for r in static if r["method"] == "standard_ds"],
                    [r for r in static if r["method"] == "dedup_ds"],
                )
            ),
            "yager_superiority_claimed": False,
            "scope": "conclusions describe controlled simulation only",
        },
        "limitations": [
            "Test includes designed mobility and source-reliability shifts, not real campus measurements.",
            "All primary methods share latest-per-source/origin preprocessing; DS dedup benefit is isolated only in raw ablation.",
            "Counterfactual refusal risk uses fixed wrong/abstain costs and makes no causal real-world claim.",
            "Latency measures this process and cache policy, not hardware-independent computational cost.",
            "Dynamic results concern one controlled six-place campus challenge family, not real-world campus trials.",
            "Policy thresholds selected on static val decision loss; dynamic utility parameters are fixed design values.",
        ],
        "counterfactual_rejection": {
            r["method"]: {
                "coverage": r["coverage"],
                "selective_risk": r["selective_risk"],
                "decision_loss": r["decision_loss"],
                "abstentions": r["abstentions"],
            }
            for r in results
            if r["experiment"] == "static" and r["condition"] == "test"
        },
        "reproduce_command": "PYTHONUTF8=1 PYTHONIOENCODING=utf-8 .venv/Scripts/python.exe tools/run_research.py --output artifacts/research",
        "elapsed_seconds": perf_counter() - start,
    }
    _csv(root / "metrics.csv", results)
    _csv(root / "paired_test_differences.csv", summary["paired_test_differences"])
    _csv(root / "dynamic_metrics.csv", dynamic["summary"])
    _csv(root / "rule_metrics.csv", rules["rows"])
    summary["figures"] = plots(root, summary)
    phase("statistics_figures", "complete", figures=len(summary["figures"]))
    summary["phases"] = phases
    summary["elapsed_seconds"] = perf_counter() - start
    _json(root / "summary.json", summary)
    _json(
        root / "phase_status.json",
        {
            "status": summary["status"],
            "phases": phases,
            "elapsed_seconds": summary["elapsed_seconds"],
        },
    )
    return summary


def supersede_dynamic(output="artifacts/research"):
    """保留首次开发运行，明确撤销其动态结论；不更动任何静态模型、预测或协议。"""
    root = Path(output).resolve()
    summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    archive = root / "revisions" / "dynamic_superseded_preapproval"
    archive.mkdir(parents=True, exist_ok=True)
    if not (archive / "superseded.json").exists():
        names = (
            "summary.json",
            "dynamic_raw.jsonl",
            "dynamic_actions.jsonl",
            "dynamic_frozen_protocol.json",
            "dynamic_metrics.csv",
            "phase_status.json",
        )
        hashes = {}
        for name in names:
            if (root / name).exists():
                shutil.copy2(root / name, archive / name)
                hashes[name] = _hash(archive / name)
        for suffix in ("png", "svg"):
            if (root / "figures" / f"03_dynamic.{suffix}").exists():
                shutil.copy2(
                    root / "figures" / f"03_dynamic.{suffix}", archive / f"03_dynamic.{suffix}"
                )
        failures = [
            json.loads(line)
            for line in (root / "dynamic_raw.jsonl").read_text(encoding="utf-8").splitlines()
            if json.loads(line)["constraint_violations"]
        ]
        _json(
            archive / "superseded.json",
            {
                "status": "superseded_not_for_final_conclusions",
                "hashes": hashes,
                "reason": "Dynamic began before explicit final approval and before observed-absence policy fix; driver hot-reloaded world only.",
                "failure_count": len(failures),
                "failures": failures,
                "root_cause": "reload(world) created a new Action class while policy.Action retained old class; dataclass equality rejected structurally legal active-query actions",
                "reproduction": {
                    "seed": 20361106,
                    "action": {
                        "kind": "ask",
                        "actor_id": "player",
                        "target": "xiaxi",
                        "item": "",
                        "minutes": 2,
                    },
                    "same_class": False,
                    "membership": False,
                    "structural_legal_match": True,
                },
                "fix": "No module reload; execute approved dynamic in a fresh process; log failed action and legal actions; zero integrity errors required",
                "static_predictions_affected": False,
                "excluded_from_final_conclusions": True,
            },
        )
    summary["status"] = "static_complete_dynamic_awaiting_approval"
    summary["dynamic"] = {
        "status": "awaiting_DYNAMIC_APPROVED",
        "summary": [],
        "superseded_run": "revisions/dynamic_superseded_preapproval/superseded.json",
    }
    summary["phases"]["dynamic"] = {"status": "superseded_awaiting_DYNAMIC_APPROVED"}
    summary["figures"] = [p for p in summary["figures"] if "03_dynamic" not in p]
    summary["reproduce_commands"] = [
        ".venv/Scripts/python.exe tools/run_research.py --output artifacts/research",
        ".venv/Scripts/python.exe tools/run_research.py --output artifacts/research --resume-dynamic --approval-file artifacts/research/dynamic_approval.json",
    ]
    _csv(root / "metrics.csv", summary["results"])
    _csv(root / "paired_test_differences.csv", summary["paired_test_differences"])
    _json(root / "static_summary.json", summary)
    _json(root / "summary.json", summary)
    _json(root / "phase_status.json", {"status": summary["status"], "phases": summary["phases"]})
    return summary


def resume_dynamic(output="artifacts/research", *, approval_file):
    """仅批准 hash 对应的新进程动态；静态原始预测和静态冻结协议保持逐字不变。"""
    root = Path(output).resolve()
    approval = json.loads(Path(approval_file).read_text(encoding="utf-8"))
    if approval.get("approval") != "DYNAMIC_APPROVED":
        raise ValueError("正式动态需要明确 DYNAMIC_APPROVED")
    from . import policy as policy_module
    from . import world as world_module

    actual = {
        "world_sha256": _hash(world_module.__file__),
        "policy_sha256": _hash(policy_module.__file__),
    }
    if any(approval.get(key) != digest for key, digest in actual.items()):
        raise ValueError(f"批准 hash 与当前源码不符，拒绝运行: {actual}")
    if policy_module.Action is not world_module.Action:
        raise RuntimeError("Action class 身份不一致；请使用独立新进程执行，不热重载 world")
    summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    protocol = json.loads((root / "frozen_protocol.json").read_text(encoding="utf-8"))
    if (
        _hash(root / "model.json") != protocol["model_sha256"]
        or _hash(root / "policy_config.json") != protocol["policy_config_sha256"]
    ):
        raise ValueError("静态冻结模型/策略阈值已改变；拒绝复用测试")
    config = ResearchConfig(**summary["config"])
    model = FiniteStateAdapter(LearnedLocationModel.load(root / "model.json"))
    selected = summary["selection"]["selected"]
    prediction_hash = _hash(root / "predictions.jsonl")
    static_protocol_hash = _hash(root / "frozen_protocol.json")
    dynamic_protocol = {
        "schema_version": 1,
        "approval": approval,
        "scenario": config.dynamic_scenario,
        **actual,
        "research_sha256": _hash(__file__),
        "config": asdict(config),
        "test_inference_started": False,
        "model_sha256": _hash(root / "model.json"),
        "policy_config_sha256": _hash(root / "policy_config.json"),
        "static_predictions_sha256": prediction_hash,
        "static_protocol_sha256": static_protocol_hash,
        "frozen_utc": datetime.now(UTC).isoformat(),
        "supersedes": "revisions/dynamic_superseded_preapproval",
        "implementation_fix": "fresh process; no hot reload; observed-absence policy bug fixed before approved dynamic",
    }
    _json(root / "dynamic_frozen_protocol.json", dynamic_protocol)
    _json(root / "phase_status.json", {"status": "dynamic_running", "phases": summary["phases"]})
    start = perf_counter()
    dynamic = dynamic_experiment(model, selected, config, root)
    if any(
        actual[key]
        != _hash(world_module.__file__ if key == "world_sha256" else policy_module.__file__)
        for key in actual
    ):
        raise RuntimeError("正式动态运行期间源码发生改变，结果不能冻结")
    if prediction_hash != _hash(root / "predictions.jsonl") or static_protocol_hash != _hash(
        root / "frozen_protocol.json"
    ):
        raise RuntimeError("动态复跑改变了静态实验，不允许定稿")
    dynamic["status"] = (
        "complete"
        if dynamic["constraint_violations_total"] == 0
        and not any(r["unfinished"] for r in dynamic["summary"])
        else "integrity_failure"
    )
    summary["dynamic"] = dynamic
    summary["status"] = (
        "complete_formal_controlled_simulation"
        if dynamic["status"] == "complete"
        else "dynamic_integrity_failure"
    )
    summary["dynamic_frozen_protocol_sha256"] = _hash(root / "dynamic_frozen_protocol.json")
    summary["phases"]["dynamic"] = {
        "status": dynamic["status"],
        "elapsed_seconds": perf_counter() - start,
        "constraint_violations_total": dynamic["constraint_violations_total"],
    }
    summary["superseded_dynamic_excluded"] = (
        "revisions/dynamic_superseded_preapproval/superseded.json"
    )
    summary["figures"] = plots(root, summary)
    _csv(root / "dynamic_metrics.csv", dynamic["summary"])
    _csv(root / "rule_metrics.csv", summary["rules"]["rows"])
    _json(root / "summary.json", summary)
    _json(root / "phase_status.json", {"status": summary["status"], "phases": summary["phases"]})
    return summary
