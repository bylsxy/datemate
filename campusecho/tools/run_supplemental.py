"""先预注册，再运行独立补充敏感性实验；不训练、不选择部署参数。"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import platform
import sys
from collections import defaultdict
from dataclasses import asdict
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from time import perf_counter

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "src"))

import numpy as np

from campusecho.data import generate_dataset, write_dataset
from campusecho.learned import LearnedLocationModel
from campusecho.policy import DISTANCES, PolicyConfig, choose_action
from campusecho.research import FiniteStateAdapter, evaluate, summarize
from campusecho.world import Action, legal_actions, observe, scenario, step

BASE = PROJECT / "artifacts/research"
OUT = BASE / "supplemental"
LEVELS = (0.35, 0.6, 0.85, 0.95)
COSTS = (0, 1, 2, 4, 8)


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def primary_digest(summary):
    payload = {
        key: summary[key]
        for key in ("config", "selection", "results", "paired_test_differences", "dynamic")
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def csv_file(path, rows):
    with Path(path).open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(
            {k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in row.items()}
            for row in rows
        )


def register():
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "supplemental_protocol.json"
    if path.exists():
        raise ValueError("预注册已存在，禁止覆盖；请直接核验后 --run")
    main = read(BASE / "summary.json")
    if main["status"] != "complete_formal_controlled_simulation":
        raise ValueError("主实验必须先完整冻结")
    protected = [
        *(PROJECT / "src/campusecho").glob("*.py"),
        BASE / "model.json",
        BASE / "policy_config.json",
        BASE / "predictions.jsonl",
        BASE / "frozen_protocol.json",
        BASE / "dynamic_frozen_protocol.json",
        BASE / "dynamic_raw.jsonl",
        BASE / "dynamic_actions.jsonl",
    ]
    protocol = {
        "schema_version": 1,
        "status": "preregistered_before_any_supplemental_inference",
        "registered_utc": datetime.now(UTC).isoformat(),
        "purpose": "Complete plan L138 conflict threshold and action query-cost sensitivity without refitting or reselection",
        "runner_sha256": digest(__file__),
        "protected_sha256": {p.relative_to(PROJECT).as_posix(): digest(p) for p in protected},
        "primary_estimates_sha256": primary_digest(main),
        "fixed_selected_parameters": main["selection"]["selected"],
        "static": {
            "seed": 20261104,
            "episodes": 1000,
            "snapshots_per_episode": 3,
            "split": "new independent test",
            "training_episodes": 0,
            "validation_episodes": 0,
            "method": "hybrid",
            "factor": "conflict_threshold",
            "levels": list(LEVELS),
            "reference": 0.85,
            "regimes": "iid/mobility_shift/reliability_shift as data generator test protocol",
            "deployment_reselection": False,
        },
        "dynamic": {
            "scenario": "challenge",
            "seed_first": 20362103,
            "seed_last": 20362202,
            "episodes_per_cost": 100,
            "main_seed_first": 20361103,
            "main_seed_last": 20361202,
            "strategy": "active",
            "factor": "query_cost",
            "levels": list(COSTS),
            "reference": 2,
            "wrong_location_cost": 15,
            "lateness_cost": 40,
            "max_queries": 2,
            "max_steps": 64,
            "physical_query_minutes": 2,
            "cost_units": "query_cost is policy objective loss units; physical elapsed query time is always 2 minutes",
            "deployment_reselection": False,
        },
        "statistics": {
            "bootstrap_replicates": 500,
            "seed": 20261104,
            "unit": "static episode / dynamic paired scenario seed",
            "ci": "percentile 95%; same resampled episode IDs across compared levels",
            "static_metrics": [
                "accuracy",
                "macro_f1",
                "brier",
                "coverage",
                "selective_risk",
                "decision_loss",
            ],
            "dynamic_metrics": [
                "success",
                "missed",
                "rescheduled",
                "queries",
                "query_time_minutes",
                "query_objective_loss_units",
                "travel_minutes",
                "extra_distance_minutes",
                "total_time_minutes",
                "constraint_violations",
            ],
        },
        "interpretation": "Supplemental prespecified sensitivity; fixed main deployment parameters and primary point estimates remain unchanged; no selection from supplemental outcomes",
    }
    write(path, protocol)
    print(f"PREREGISTERED {path}\nsha256={digest(path)}", flush=True)


def check_protected(protocol):
    if digest(__file__) != protocol["runner_sha256"]:
        raise ValueError("补充执行器与预注册hash不符")
    changed = [p for p, sha in protocol["protected_sha256"].items() if digest(PROJECT / p) != sha]
    if changed:
        raise ValueError(f"主实验保护文件发生变化: {changed}")
    if primary_digest(read(BASE / "summary.json")) != protocol["primary_estimates_sha256"]:
        raise ValueError("主实验参数或点估计发生变化")


def scalar_summary(rows, keys, n_boot, seed, unit="paired scenario seed"):
    values = np.asarray([[float(row[k]) for k in keys] for row in rows])
    rng = np.random.default_rng(seed)
    draws = values[rng.integers(len(rows), size=(n_boot, len(rows)))].mean(1)
    out = {"episodes": len(rows), "bootstrap_unit": unit, "bootstrap_replicates": n_boot}
    for j, key in enumerate(keys):
        out[key] = float(values[:, j].mean())
        out[key + "_ci95"] = np.quantile(draws[:, j], [0.025, 0.975]).tolist()
    return out


def pair_differences(rows, factor, levels, reference, keys, config):
    grouped = defaultdict(dict)
    for row in rows:
        grouped[row[factor]][row["episode_id"]] = row
    result = []
    for level in levels:
        if level == reference:
            continue
        assert set(grouped[level]) == set(grouped[reference])
        ids = sorted(grouped[level])
        differences = [
            {
                "episode_id": e,
                **{
                    key: float(grouped[level][e][key]) - float(grouped[reference][e][key])
                    for key in keys
                },
            }
            for e in ids
        ]
        unit = "paired episode" if factor == "conflict_threshold" else "paired scenario seed"
        result.append(
            {
                factor: level,
                "reference": reference,
                "direction": "level minus reference",
                **scalar_summary(
                    differences, keys, config["bootstrap_replicates"], config["seed"], unit
                ),
            }
        )
    return result


def run_static(model, protocol):
    cfg = protocol["static"]
    data = generate_dataset(
        seed=cfg["seed"],
        train_episodes=0,
        val_episodes=0,
        test_episodes=cfg["episodes"],
        snapshots=cfg["snapshots_per_episode"],
    )
    manifest = write_dataset(OUT / "dataset", data)
    ids = {c.episode_id for c in data["test"]}
    main_ids = {e["episode_id"] for e in read(BASE / "dataset/manifest.json")["episodes"]}
    assert not ids & main_ids and len(ids) == 1000 and len(data["test"]) == 3000
    rows, stats = [], []
    with (OUT / "static_predictions.jsonl").open("w", encoding="utf-8") as f:
        for level in cfg["levels"]:
            subset = evaluate(
                data["test"],
                ["hybrid"],
                model,
                {**protocol["fixed_selected_parameters"], "conflict_threshold": level},
                experiment="supplemental_conflict_threshold",
                condition=level,
                output=f,
            )
            rows.extend(subset)
            stats.append(
                {"conflict_threshold": level, **summarize(subset, bootstrap=500, seed=20261104)}
            )
            print(f"static conflict_threshold={level}: {len(subset)} snapshots", flush=True)
    csv_file(OUT / "static_metrics.csv", stats)
    # 三张快照先在episode内聚合，避免把相关快照当成独立样本。
    by = defaultdict(list)
    for row in rows:
        by[(float(row["condition"]), row["episode_id"])].append(row)
    episode_rows = [
        {
            "conflict_threshold": level,
            "episode_id": episode,
            "accuracy": np.mean([r["correct"] for r in group]),
            "coverage": np.mean([r["covered"] for r in group]),
            "brier": np.mean([r["brier"] for r in group]),
            "decision_loss": np.mean(
                [
                    float(r["covered"] and not r["correct"]) + 0.35 * float(not r["covered"])
                    for r in group
                ]
            ),
        }
        for (level, episode), group in by.items()
    ]
    paired = pair_differences(
        episode_rows,
        "conflict_threshold",
        cfg["levels"],
        cfg["reference"],
        ("accuracy", "coverage", "brier", "decision_loss"),
        protocol["statistics"],
    )
    csv_file(OUT / "static_paired_differences.csv", paired)
    return {
        "summary": stats,
        "paired_differences": paired,
        "prediction_rows": len(rows),
        "independent_episodes": len(ids),
        "manifest": "dataset/manifest.json",
        "dataset_sha256": manifest["splits"]["test"]["sha256"],
        "no_main_episode_overlap": True,
    }


def run_dynamic(model, protocol):
    cfg, stat = protocol["dynamic"], protocol["statistics"]
    rows, stats = [], []
    with (OUT / "dynamic_actions.jsonl").open("w", encoding="utf-8") as actions:
        for seed in range(cfg["seed_first"], cfg["seed_last"] + 1):
            initial = scenario(cfg["scenario"], seed)
            initial_hash = hashlib.sha256(initial.to_json().encode()).hexdigest()
            for cost in cfg["levels"]:
                policy = PolicyConfig(
                    confidence_threshold=protocol["fixed_selected_parameters"][
                        "confidence_threshold"
                    ],
                    conflict_threshold=protocol["fixed_selected_parameters"]["conflict_threshold"],
                    query_cost=cost,
                    wrong_location_cost=cfg["wrong_location_cost"],
                    lateness_cost=cfg["lateness_cost"],
                    max_queries=cfg["max_queries"],
                )
                world, steps, walked, queries, violations, seconds, error = (
                    initial,
                    0,
                    0,
                    0,
                    0,
                    0.0,
                    None,
                )
                while world.task.status == "active" and steps < cfg["max_steps"]:
                    view = observe(world, "player")
                    started = perf_counter()
                    choice = choose_action(view, model, strategy="active", config=policy)
                    seconds += perf_counter() - started
                    action = choice.action or Action("wait", "player", minutes=1)
                    if action not in legal_actions(view):
                        violations += 1
                        error = {
                            "reason": "illegal_action",
                            "action": asdict(action),
                            "legal": [asdict(a) for a in legal_actions(view)],
                        }
                        break
                    updated = step(world, action)
                    if updated.tick <= world.tick or (
                        action.kind == "ask" and updated.tick - world.tick != 2
                    ):
                        violations += 1
                        error = {
                            "reason": "time_progress_or_query_duration",
                            "action": asdict(action),
                        }
                        break
                    actions.write(
                        json.dumps(
                            {
                                "episode_id": str(seed),
                                "query_cost": cost,
                                "step": steps,
                                "tick": world.tick,
                                "location": view.location,
                                "action": asdict(action),
                                "reason": choice.reason,
                                "information_value": choice.information_value,
                                "expected_cost": choice.expected_cost,
                                "status_after": updated.task.status,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    walked += action.minutes if action.kind == "move" else 0
                    queries += action.kind == "ask"
                    world, steps = updated, steps + 1
                rows.append(
                    {
                        "episode_id": str(seed),
                        "seed": seed,
                        "query_cost": cost,
                        "strategy": "active",
                        "initial_world_sha256": initial_hash,
                        "external_schedule_sha256": hashlib.sha256(
                            repr(initial.schedules).encode()
                        ).hexdigest(),
                        "status": world.task.status,
                        "success": world.task.status == "success",
                        "missed": world.task.status == "missed",
                        "rescheduled": world.task.status == "rescheduled",
                        "steps": steps,
                        "travel_minutes": walked,
                        "extra_distance_minutes": max(
                            0, walked - DISTANCES[observe(initial, "player").location]["venue"]
                        ),
                        "queries": queries,
                        "query_time_minutes": queries * 2,
                        "query_objective_loss_units": queries * cost,
                        "total_time_minutes": world.tick - initial.tick,
                        "decision_wall_seconds": seconds,
                        "constraint_violations": violations,
                        "error": error,
                    }
                )
            if (seed - cfg["seed_first"] + 1) % 20 == 0:
                print(f"dynamic {seed - cfg['seed_first'] + 1}/100 paired seeds", flush=True)
    with (OUT / "dynamic_raw.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    keys = tuple(stat["dynamic_metrics"])
    for cost in cfg["levels"]:
        group = [r for r in rows if r["query_cost"] == cost]
        stats.append(
            {
                "query_cost": cost,
                **scalar_summary(group, keys, stat["bootstrap_replicates"], stat["seed"]),
                "unfinished": sum(r["status"] == "active" for r in group),
            }
        )
    paired = pair_differences(rows, "query_cost", cfg["levels"], cfg["reference"], keys, stat)
    csv_file(OUT / "dynamic_metrics.csv", stats)
    csv_file(OUT / "dynamic_paired_differences.csv", paired)
    failed = [r for r in rows if not r["success"]]
    write(OUT / "dynamic_failure_cases.json", failed)
    return {
        "summary": stats,
        "paired_differences": paired,
        "rows": len(rows),
        "paired_seeds": 100,
        "constraint_violations_total": sum(r["constraint_violations"] for r in rows),
        "unfinished": sum(r["status"] == "active" for r in rows),
        "failures_preserved": len(failed),
        "same_initial_world": all(
            len({r["initial_world_sha256"] for r in rows if r["seed"] == seed}) == 1
            for seed in range(cfg["seed_first"], cfg["seed_last"] + 1)
        ),
    }


def plot_results(result):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    output = OUT / "figures"
    output.mkdir(exist_ok=True)
    paths = []

    def draw(rows, factor, keys, title, name):
        fig, axes = plt.subplots(1, len(keys), figsize=(5 * len(keys), 4.6), squeeze=False)
        for ax, key in zip(axes.flat, keys):
            y = np.array([r[key] for r in rows], dtype=float)
            ci = np.array(
                [
                    r[key + "_ci95"] if r[key + "_ci95"] is not None else [np.nan, np.nan]
                    for r in rows
                ],
                dtype=float,
            )
            ax.errorbar(
                [r[factor] for r in rows],
                y,
                yerr=np.maximum(0, np.array([y - ci[:, 0], ci[:, 1] - y])),
                marker="o",
                capsize=3,
            )
            ax.set_xlabel(factor + (" (policy loss units)" if factor == "query_cost" else ""))
            ax.set_ylabel(key)
            ax.grid(alpha=0.2)
        fig.suptitle(title)
        fig.tight_layout()
        for ext in ("png", "svg"):
            path = output / f"{name}.{ext}"
            fig.savefig(path, dpi=140, bbox_inches="tight")
            paths.append(path.relative_to(OUT).as_posix())
        plt.close(fig)

    draw(
        result["static"]["summary"],
        "conflict_threshold",
        ("coverage", "selective_risk", "decision_loss"),
        "Prespecified conflict sensitivity: 1000 new episodes / 3000 snapshots; episode 95% CI",
        "01_conflict_threshold",
    )
    draw(
        result["dynamic"]["summary"],
        "query_cost",
        ("success", "queries", "total_time_minutes"),
        "Active cost sensitivity: 100 new paired seeds; query duration fixed 2 minutes; 95% CI",
        "02_query_cost",
    )
    draw(
        result["dynamic"]["summary"],
        "query_cost",
        ("query_time_minutes", "query_objective_loss_units", "extra_distance_minutes"),
        "Physical minutes and policy loss units reported separately; 100 paired seeds; 95% CI",
        "03_cost_units",
    )
    return paths


def run():
    path = OUT / "supplemental_protocol.json"
    protocol = read(path)
    if (OUT / "summary.json").exists():
        raise ValueError("补充结果已存在，禁止无因覆盖")
    check_protected(protocol)
    protocol_hash = digest(path)
    started = perf_counter()
    write(OUT / "phase_status.json", {"status": "running", "protocol_sha256": protocol_hash})
    model = FiniteStateAdapter(LearnedLocationModel.load(BASE / "model.json"))
    result = {
        "schema_version": 1,
        "status": "running",
        "protocol_sha256": protocol_hash,
        "registered_protocol": "supplemental_protocol.json",
        "environment": {
            "python": sys.version,
            "executable": sys.executable,
            "platform": platform.platform(),
            **{k: version(k) for k in ("numpy", "pgmpy", "matplotlib")},
        },
        "bootstrap": protocol["statistics"],
        "deployment_reselection": False,
    }
    result["static"] = run_static(model, protocol)
    result["dynamic"] = run_dynamic(model, protocol)
    result["figures"] = plot_results(result)
    check_protected(protocol)
    assert protocol_hash == digest(path)
    result["status"] = (
        "complete_prespecified_supplemental"
        if result["dynamic"]["constraint_violations_total"] == 0
        and result["dynamic"]["unfinished"] == 0
        else "integrity_failure"
    )
    result["elapsed_seconds"] = perf_counter() - started
    result["protected_hashes_unchanged"] = True
    result["main_point_estimates_unchanged"] = True
    result["scope"] = protocol["interpretation"]
    write(OUT / "summary.json", result)
    write(
        OUT / "phase_status.json",
        {
            "status": result["status"],
            "protocol_sha256": protocol_hash,
            "elapsed_seconds": result["elapsed_seconds"],
        },
    )
    main = read(BASE / "summary.json")
    main["supplemental"] = {
        "summary": "supplemental/summary.json",
        "protocol": "supplemental/supplemental_protocol.json",
        "status": result["status"],
        "purpose": protocol["purpose"],
        "deployment_reselection": False,
    }
    assert primary_digest(main) == protocol["primary_estimates_sha256"]
    write(BASE / "summary.json", main)
    print(result["status"], flush=True)
    if result["status"] != "complete_prespecified_supplemental":
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--register", action="store_true")
    group.add_argument("--run", action="store_true")
    args = parser.parse_args()
    register() if args.register else run()
