"""预注册的规则三配置与不同origin隐相关附录；不修改主推理器。"""

from __future__ import annotations

import argparse
import csv
import hashlib
import itertools
import json
import platform
import random
import sys
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "src"))

import numpy as np

from campusecho.data import generate_dataset, write_dataset
from campusecho.evidence import Evidence
from campusecho.learned import LearnedLocationModel, prepare_evidence
from campusecho.logic import (
    Atom,
    Derivation,
    InferenceMetrics,
    InferenceResult,
    Rule,
    Var,
    _Counters,
    _FactIndex,
    _join,
    _validate_program,
    forward_chain,
)
from campusecho.research import FiniteStateAdapter, evaluate, summarize
from campusecho.world import FRAME

BASE = PROJECT / "artifacts/research"
OUT = BASE / "ablation"
METHODS = ("naive", "index_only", "semi_naive")
CORR_METHODS = ("bayes", "strong_bayes", "standard_ds", "discount_ds")
SOURCES = ("roommate", "clubmate", "camera", "direct")


def index_only(facts, rules):
    """每轮对全部规则及全部已知事实作索引联结；没有old/delta结构。"""
    started = perf_counter()
    fact_input, rules = tuple(facts), tuple(rules)
    _validate_program(fact_input, rules)
    initial = frozenset(fact_input)
    known = set(initial)
    full_index = _FactIndex(initial, indexed=True)
    counters = _Counters()
    trace, round_number = [], 0
    while True:
        round_number += 1
        new = {}
        for rule in rules:
            counters.rule_evaluations += 1
            for binding, premises in _join(rule.body, (full_index,) * len(rule.body), counters):
                counters.rule_matches += 1
                head = Atom(
                    rule.head.predicate,
                    tuple(binding[t.name] if isinstance(t, Var) else t for t in rule.head.args),
                )
                if head not in known and head not in new:
                    new[head] = Derivation(
                        head, rule.id, tuple(sorted(binding.items())), premises, round_number
                    )
        if not new:
            break
        trace.extend(new.values())
        known.update(new)
        full_index.extend(new)
    return InferenceResult(
        frozenset(known),
        tuple(trace),
        InferenceMetrics(
            "index_only",
            round_number,
            counters.rule_evaluations,
            counters.candidate_checks,
            counters.rule_matches,
            len(initial),
            len(trace),
            len(known),
            perf_counter() - started,
        ),
        initial,
    )


def grounded_oracle(facts, rules, domain):
    """有限域完全实例化；不调用统一、索引或待测联结函数。"""
    grounded = []
    for rule in rules:
        variables = sorted(set().union(*(a.variables for a in (rule.head, *rule.body))))
        for values in itertools.product(domain, repeat=len(variables)):
            binding = dict(zip(variables, values))

            def instantiate(a, binding=binding):
                return Atom(
                    a.predicate, tuple(binding[t.name] if isinstance(t, Var) else t for t in a.args)
                )

            grounded.append((instantiate(rule.head), tuple(instantiate(a) for a in rule.body)))
    known = set(facts)
    while True:
        additions = {h for h, body in grounded if all(a in known for a in body)} - known
        if not additions:
            return frozenset(known)
        known.update(additions)


def rule_fixture(kind, size):
    x = Var("x")
    if kind == "synthetic_facts":
        facts = {Atom("Signal", (i,)) for i in range(12)} | {
            Atom("Distractor", (i,)) for i in range(size - 12)
        }
        rules = (
            Rule("seen", Atom("Seen", (x,)), (Atom("Signal", (x,)),)),
            Rule("known", Atom("Known", (x,)), (Atom("Seen", (x,)),)),
        )
        expected = frozenset(facts | {Atom(p, (i,)) for p in ("Seen", "Known") for i in range(12)})
    else:
        facts = {Atom("Signal", (1,))}
        rules = tuple(
            Rule(
                f"rule-{i}",
                Atom(f"Result{i}", (x,)),
                (Atom("Signal" if i < 12 else f"Absent{i}", (x,)),),
            )
            for i in range(size)
        )
        expected = frozenset(facts | {Atom(f"Result{i}", (1,)) for i in range(12)})
    return facts, rules, expected


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def csv_file(path, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(
            {k: json.dumps(v) if isinstance(v, (dict, list)) else v for k, v in row.items()}
            for row in rows
        )


def primary_digest(summary):
    return hashlib.sha256(
        json.dumps(
            {
                key: summary[key]
                for key in ("config", "selection", "results", "paired_test_differences", "dynamic")
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


def closure_hash(facts):
    return hashlib.sha256(
        repr(sorted((a.predicate, repr(a.args)) for a in facts)).encode()
    ).hexdigest()


def register():
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "ablation_protocol.json"
    if path.exists():
        raise ValueError("已有预注册禁止覆盖")
    protected = [
        *(PROJECT / "src/campusecho").glob("*.py"),
        BASE / "model.json",
        BASE / "policy_config.json",
        BASE / "predictions.jsonl",
        BASE / "frozen_protocol.json",
        BASE / "dynamic_frozen_protocol.json",
        BASE / "dynamic_raw.jsonl",
        BASE / "dynamic_actions.jsonl",
        BASE / "supplemental/supplemental_protocol.json",
        BASE / "supplemental/static_predictions.jsonl",
        BASE / "supplemental/dynamic_raw.jsonl",
    ]
    main = load(BASE / "summary.json")
    protocol = {
        "status": "preregistered_before_appendix_inference",
        "registered_utc": datetime.now(UTC).isoformat(),
        "runner_sha256": digest(__file__),
        "protected_sha256": {p.relative_to(PROJECT).as_posix(): digest(p) for p in protected},
        "primary_estimates_sha256": primary_digest(main),
        "rules": {
            "fixtures": ["synthetic_facts", "synthetic_rules"],
            "sizes": [100, 1000, 10000],
            "methods": list(METHODS),
            "repeats": 5,
            "warmups_per_fixture_method": 1,
            "execution_order": "cyclic method rotation by repeat",
            "oracle": "closed-form exact fixture closures plus finite grounding oracle test on nonlinear recursive Horn rules",
            "index_only": "full known-fact indexed joins for every rule on every synchronous round; no delta/old index; reuses logic._FactIndex/_join/_Counters/_validate_program",
            "timing": "perf_counter engine elapsed including index construction; empirical P50/P95 from five repeats; same-process sequential CPU",
            "counts": [
                "rounds",
                "rule_evaluations",
                "candidate_checks",
                "rule_matches",
                "initial_fact_count",
                "derived_fact_count",
                "total_fact_count",
            ],
        },
        "correlation": {
            "new_seed": 20261105,
            "episodes": 100,
            "snapshots_per_episode": 3,
            "levels": [0, 0.25, 0.5, 0.75, 1],
            "factor": "fraction of episodes whose four different-origin source reports share the same latent error and wrong label",
            "nested_shared_episode_sets": True,
            "sources": list(SOURCES),
            "methods": list(CORR_METHODS),
            "error_episodes_per_source_per_level": 20,
            "marginal_source_accuracy_exact": 0.8,
            "report_time": "contemporaneous at each snapshot",
            "reports_per_snapshot": 4,
            "origin_policy": "four unique source/origin IDs; no copy or duplicate origin; hidden dependence absent from model inputs",
            "latent_design": "one common 20-episode error mask; shared episodes follow it; each source samples the residual number of independent errors outside shared episodes to retain exactly 20 error episodes at every level; common wrong labels within shared episodes",
            "truth_use": "evaluator builds controlled noisy channels and scores; inference receives only Evidence/time/context",
            "metrics": [
                "accuracy",
                "macro_f1",
                "brier",
                "coverage",
                "selective_risk",
                "decision_loss",
                "ece10",
                "mean_confidence",
            ],
            "calibration": "ECE 10 equal-width confidence bins; confidence is max posterior; correctness uses posterior argmax; bin totals clustered by episode for CI",
            "scope": "controlled contemporaneous-report appendix; generator supplies new truth/context paths; no claim that origin dedup identifies hidden dependence",
        },
        "statistics": {
            "bootstrap_replicates": 500,
            "seed": 20261105,
            "unit": "episode",
            "ci": "percentile 95% episode bootstrap, all three snapshots kept together",
        },
        "fixed_selected_parameters": main["selection"]["selected"],
        "deployment_reselection": False,
        "main_results_policy": "appendix link only; main point estimates and deployed parameters stay frozen",
    }
    write(path, protocol)
    print(f"PREREGISTERED {path}\nsha256={digest(path)}", flush=True)


def protect(protocol):
    assert digest(__file__) == protocol["runner_sha256"]
    changed = [p for p, sha in protocol["protected_sha256"].items() if digest(PROJECT / p) != sha]
    if changed:
        raise ValueError(f"主冻结文件发生改变: {changed}")
    assert primary_digest(load(BASE / "summary.json")) == protocol["primary_estimates_sha256"]


def benchmark_rules(protocol):
    rows, summaries = [], []
    for kind in protocol["rules"]["fixtures"]:
        for size in protocol["rules"]["sizes"]:
            facts, rules, expected = rule_fixture(kind, size)
            fixture_hash = hashlib.sha256(
                repr((sorted(map(repr, facts)), tuple(map(repr, rules)))).encode()
            ).hexdigest()
            for method in METHODS:
                result = (
                    index_only(facts, rules)
                    if method == "index_only"
                    else forward_chain(facts, rules, method)
                )
                assert result.facts == expected
            for repeat in range(5):
                order = METHODS[repeat % 3 :] + METHODS[: repeat % 3]
                for order_position, method in enumerate(order):
                    result = (
                        index_only(facts, rules)
                        if method == "index_only"
                        else forward_chain(facts, rules, method)
                    )
                    assert result.facts == expected
                    rows.append(
                        {
                            "fixture": kind,
                            "size": size,
                            "rules": len(rules),
                            "input_facts": len(facts),
                            "repeat": repeat,
                            "order_position": order_position,
                            "fixture_sha256": fixture_hash,
                            "closure_sha256": closure_hash(result.facts),
                            "oracle_closure_sha256": closure_hash(expected),
                            "closure_equal_oracle": True,
                            **result.metrics.as_dict(),
                        }
                    )
            for method in METHODS:
                group = [
                    r
                    for r in rows
                    if r["fixture"] == kind and r["size"] == size and r["method"] == method
                ]
                metrics = {k: group[0][k] for k in protocol["rules"]["counts"]}
                assert all(all(row[k] == v for k, v in metrics.items()) for row in group)
                summaries.append(
                    {
                        "fixture": kind,
                        "size": size,
                        "method": method,
                        "repeats": 5,
                        "rules": len(rules),
                        "input_facts": len(facts),
                        "elapsed_p50_seconds": float(
                            np.quantile([r["elapsed_seconds"] for r in group], 0.5)
                        ),
                        "elapsed_p95_seconds": float(
                            np.quantile([r["elapsed_seconds"] for r in group], 0.95)
                        ),
                        "closure_equal_oracle": True,
                        **metrics,
                    }
                )
            print(f"rules {kind} n={size}: 3 methods x 5 repeats; closures equal", flush=True)
    with (OUT / "rule_raw.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    csv_file(OUT / "rule_metrics.csv", summaries)
    return {"rows": rows, "summary": summaries, "closure_equal_all": True, "repeats": 5}


def correlation_cases(base_cases, level, seed=20261105):
    """匹配边际错误率，单独改变跨origin共同潜在错误的覆盖比例。"""
    ids = sorted({c.episode_id for c in base_cases})
    if len(ids) % 5:
        raise ValueError("平衡错误设计需要episode数量为5的倍数")
    order = ids.copy()
    random.Random(seed + 1).shuffle(order)
    shared = set(order[: round(level * len(ids))])
    common_errors = set(random.Random(seed + 2).sample(ids, len(ids) // 5))
    outside = sorted(set(ids) - shared)
    errors = {}
    for i, source in enumerate(SOURCES):
        common_part = common_errors & shared
        errors[source] = common_part | set(
            random.Random(seed + 100 + i).sample(outside, len(ids) // 5 - len(common_part))
        )
    transformed, audit = [], []
    for case in base_cases:
        frame = sorted(FRAME)
        wrong = [s for s in frame if s != case.truth]
        common_label = random.Random(f"{seed}:{case.case_id}:latent-label").choice(wrong)
        reports = []
        channel_rows = []
        for source in SOURCES:
            is_error = case.episode_id in errors[source]
            wrong_label = (
                common_label
                if case.episode_id in shared
                else random.Random(f"{seed}:{case.case_id}:{source}:independent-label").choice(
                    wrong
                )
            )
            label = wrong_label if is_error else case.truth
            origin = f"{case.case_id}:unique-{source}"
            reports.append(Evidence(origin, source, origin, {label}, 0.8, case.now, case.now))
            channel_rows.append(
                {"source_id": source, "origin_id": origin, "is_error": is_error, "support": label}
            )
        updated = replace(case, evidence=tuple(reports))
        assert len(prepare_evidence(updated.evidence, updated.now).selected) == 4
        transformed.append(updated)
        audit.append(
            {
                "correlation_fraction": level,
                "episode_id": case.episode_id,
                "case_id": case.case_id,
                "hidden_shared_channel": case.episode_id in shared,
                "latent_error": case.episode_id in common_errors,
                "channels": channel_rows,
                "case": updated.to_dict(),
            }
        )
    return tuple(transformed), audit


def calibration(rows, seed=20261105, bootstrap=500):
    ids = sorted({r["episode_id"] for r in rows})
    index = {e: i for i, e in enumerate(ids)}
    stats = np.zeros((len(ids), 10, 3))
    for row in rows:
        probabilities = row["probabilities"]
        prediction = min(probabilities, key=lambda s: (-probabilities[s], s))
        confidence = probabilities[prediction]
        bin_id = min(9, int(confidence * 10))
        stats[index[row["episode_id"]], bin_id] += (1, prediction == row["truth"], confidence)

    def metrics(total):
        n = total[..., :, 0].sum(-1)
        return {
            "ece10": abs(total[..., :, 1] - total[..., :, 2]).sum(-1) / n,
            "mean_confidence": total[..., :, 2].sum(-1) / n,
        }

    total = stats.sum(0)
    rng = np.random.default_rng(seed)
    weights = rng.multinomial(len(ids), np.full(len(ids), 1 / len(ids)), size=bootstrap)
    draws = metrics((weights @ stats.reshape(len(ids), -1)).reshape(bootstrap, 10, 3))
    output = {}
    for key, value in metrics(total).items():
        output[key] = float(value)
        output[key + "_ci95"] = np.quantile(draws[key], [0.025, 0.975]).tolist()
    output["calibration_bins"] = [
        {
            "bin": i,
            "count": int(v[0]),
            "accuracy": float(v[1] / v[0]) if v[0] else None,
            "confidence": float(v[2] / v[0]) if v[0] else None,
        }
        for i, v in enumerate(total)
    ]
    return output


def run_correlation(protocol):
    cfg = protocol["correlation"]
    dataset = generate_dataset(
        seed=cfg["new_seed"],
        train_episodes=0,
        val_episodes=0,
        test_episodes=cfg["episodes"],
        snapshots=3,
    )
    manifest = write_dataset(OUT / "base_dataset", dataset)
    main_ids = {r["episode_id"] for r in load(BASE / "dataset/manifest.json")["episodes"]}
    sup_ids = {
        r["episode_id"] for r in load(BASE / "supplemental/dataset/manifest.json")["episodes"]
    }
    assert not {c.episode_id for c in dataset["test"]} & (main_ids | sup_ids)
    model = FiniteStateAdapter(LearnedLocationModel.load(BASE / "model.json"))
    summaries, dependency, n_predictions = [], [], 0
    with (
        (OUT / "correlation_inputs.jsonl").open("w", encoding="utf-8") as inputs,
        (OUT / "correlation_predictions.jsonl").open("w", encoding="utf-8") as output,
    ):
        for level in cfg["levels"]:
            cases, audit = correlation_cases(dataset["test"], level, cfg["new_seed"])
            for row in audit:
                inputs.write(json.dumps(row, ensure_ascii=False) + "\n")
            flags = np.array([[int(c["is_error"]) for c in row["channels"]] for row in audit])
            pair_phi = [
                float(np.corrcoef(flags[:, i], flags[:, j])[0, 1])
                for i in range(4)
                for j in range(i + 1, 4)
            ]
            dependency.append(
                {
                    "correlation_fraction": level,
                    "shared_episodes": len(
                        {r["episode_id"] for r in audit if r["hidden_shared_channel"]}
                    ),
                    "source_error_rates": dict(zip(SOURCES, flags.mean(0).tolist())),
                    "mean_pairwise_error_phi": float(np.mean(pair_phi)),
                    "unique_origins_per_snapshot": 4,
                    "reports_retained_after_preprocessing": 4,
                }
            )
            rows = evaluate(
                cases,
                CORR_METHODS,
                model,
                protocol["fixed_selected_parameters"],
                experiment="hidden_cross_origin_correlation",
                condition=level,
                output=output,
            )
            n_predictions += len(rows)
            for method in CORR_METHODS:
                subset = [r for r in rows if r["method"] == method]
                summaries.append(
                    {
                        "correlation_fraction": level,
                        "method": method,
                        **summarize(subset, bootstrap=500, seed=20261105),
                        **calibration(subset),
                    }
                )
            print(
                f"hidden correlation fraction={level}: 100 episodes / 300 snapshots / 4 methods",
                flush=True,
            )
    csv_file(OUT / "correlation_metrics.csv", summaries)
    csv_file(OUT / "dependency_diagnostics.csv", dependency)
    write(OUT / "dependency_diagnostics.json", dependency)
    return {
        "summary": summaries,
        "dependency_diagnostics": dependency,
        "prediction_rows": n_predictions,
        "base_dataset_sha256": manifest["splits"]["test"]["sha256"],
        "independent_new_seed": cfg["new_seed"],
        "no_main_or_supplemental_episode_overlap": True,
    }


def plots(results):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    target = OUT / "figures"
    target.mkdir(exist_ok=True)
    paths = []

    def save(fig, name):
        for suffix in ("png", "svg"):
            path = target / f"{name}.{suffix}"
            fig.savefig(path, dpi=140, bbox_inches="tight")
            paths.append(path.relative_to(OUT).as_posix())
        plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for ax, fixture in zip(axes, ("synthetic_facts", "synthetic_rules")):
        for method in METHODS:
            rows = [
                r
                for r in results["rules"]["summary"]
                if r["fixture"] == fixture and r["method"] == method
            ]
            ax.plot(
                [r["size"] for r in rows],
                [r["elapsed_p50_seconds"] for r in rows],
                "o-",
                label=method + " P50",
            )
            ax.plot(
                [r["size"] for r in rows],
                [r["elapsed_p95_seconds"] for r in rows],
                ":",
                alpha=0.6,
                label=method + " P95",
            )
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xlabel(fixture + " size")
        ax.set_ylabel("elapsed seconds")
        ax.grid(alpha=0.2)
        ax.legend(fontsize=7)
    fig.suptitle(
        "Same Horn fixtures; 3 distinct evaluation configurations; 5 measured repeats after warmup"
    )
    fig.tight_layout()
    save(fig, "01_rule_three_configs")
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for ax, fixture in zip(axes, ("synthetic_facts", "synthetic_rules")):
        for method in METHODS:
            rows = [
                r
                for r in results["rules"]["summary"]
                if r["fixture"] == fixture and r["method"] == method
            ]
            ax.plot(
                [r["size"] for r in rows],
                [max(1, r["candidate_checks"]) for r in rows],
                "o-",
                label=method,
            )
        ax.set_xscale("log")
        ax.set_yscale("log")
        ax.set_xlabel(fixture + " size")
        ax.set_ylabel("candidate unification checks")
        ax.legend()
        ax.grid(alpha=0.2)
    fig.suptitle(
        "All closures match exact oracle; operation counts distinguish index from delta gains"
    )
    fig.tight_layout()
    save(fig, "02_rule_candidate_checks")
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    for ax, metric in zip(axes.flat, ("accuracy", "brier", "ece10", "mean_confidence")):
        for method in CORR_METHODS:
            rows = [r for r in results["correlation"]["summary"] if r["method"] == method]
            y = np.array([r[metric] for r in rows])
            ci = np.array([r[metric + "_ci95"] for r in rows])
            ax.errorbar(
                [r["correlation_fraction"] for r in rows],
                y,
                yerr=np.maximum(0, np.array([y - ci[:, 0], ci[:, 1] - y])),
                marker="o",
                capsize=2,
                label=method,
            )
        ax.set_xlabel("Fraction of episodes with hidden shared error")
        ax.set_ylabel(metric)
        ax.grid(alpha=0.2)
    axes[0, 0].legend(fontsize=8)
    fig.suptitle(
        "4 unique origins; exact 80% marginal source accuracy at every level; 100 paired episodes; 95% CI"
    )
    fig.tight_layout()
    save(fig, "03_hidden_correlation")
    fig, axes = plt.subplots(2, 2, figsize=(10, 8))
    for ax, method in zip(axes.flat, CORR_METHODS):
        ax.plot([0, 1], [0, 1], "--", color="grey", linewidth=1)
        for level in (0, 1):
            row = next(
                r
                for r in results["correlation"]["summary"]
                if r["method"] == method and r["correlation_fraction"] == level
            )
            bins = [v for v in row["calibration_bins"] if v["count"]]
            ax.plot(
                [v["confidence"] for v in bins],
                [v["accuracy"] for v in bins],
                "o-",
                label=f"shared fraction {level}",
            )
        ax.set_title(method)
        ax.set_xlabel("mean posterior confidence within bin")
        ax.set_ylabel("empirical accuracy within bin")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.legend(fontsize=8)
        ax.grid(alpha=0.2)
    fig.suptitle(
        "Endpoint reliability diagrams; 10 fixed equal-width bins; no hidden-dependence correction"
    )
    fig.tight_layout()
    save(fig, "04_calibration_endpoints")
    return paths


def run():
    protocol_path = OUT / "ablation_protocol.json"
    protocol = load(protocol_path)
    if (OUT / "summary.json").exists():
        raise ValueError("附录结果已存在，禁止无因重跑")
    protect(protocol)
    protocol_hash = digest(protocol_path)
    start = perf_counter()
    write(OUT / "phase_status.json", {"status": "running", "protocol_sha256": protocol_hash})
    result = {
        "status": "running",
        "protocol_sha256": protocol_hash,
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "executable": sys.executable,
        },
        "deployment_reselection": False,
    }
    result["rules"] = benchmark_rules(protocol)
    result["correlation"] = run_correlation(protocol)
    result["figures"] = plots(result)
    protect(protocol)
    assert digest(protocol_path) == protocol_hash
    result.update(
        {
            "status": "complete_prespecified_ablation_appendix",
            "protected_hashes_unchanged": True,
            "main_point_estimates_unchanged": True,
            "elapsed_seconds": perf_counter() - start,
            "limitations": [
                "Five timing repeats give empirical P50/P95 for this machine, not a portable speed guarantee.",
                "Hidden-dependence appendix uses controlled contemporaneous noisy channels on new truth/context paths.",
                "Origin IDs are distinct; metadata dedup cannot automatically detect the injected latent dependence.",
                "Only the designed correlation mechanism and 100 paired simulated episodes are evaluated; no deployment reselection.",
            ],
        }
    )
    write(OUT / "summary.json", result)
    write(
        OUT / "phase_status.json",
        {
            "status": result["status"],
            "elapsed_seconds": result["elapsed_seconds"],
            "protocol_sha256": protocol_hash,
        },
    )
    main = load(BASE / "summary.json")
    main["ablation_appendix"] = {
        "summary": "ablation/summary.json",
        "protocol": "ablation/ablation_protocol.json",
        "status": result["status"],
        "deployment_reselection": False,
    }
    assert primary_digest(main) == protocol["primary_estimates_sha256"]
    write(BASE / "summary.json", main)
    print(result["status"], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--register", action="store_true")
    group.add_argument("--run", action="store_true")
    args = parser.parse_args()
    register() if args.register else run()
