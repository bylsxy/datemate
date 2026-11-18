"""初步受控仿真基准；设计参数尚未由独立轨迹训练或校准。"""

import json
import platform
import random
from dataclasses import replace
from importlib.metadata import version
from pathlib import Path
from statistics import mean
from time import perf_counter

from .engine import analyze
from .evidence import Evidence
from .logic import Atom, Rule, Var, forward_chain
from .world import FRAME, Observation, observe, scenario


def synthetic_case(seed: int, noise: float):
    """独立实例的真实位置与错误报告；这不是完整动态日程模拟器。"""
    rng = random.Random(seed)
    states = sorted(FRAME)
    truth = rng.choice(states)
    world = scenario(seed=seed)
    actors = tuple(replace(a, location=truth) if a.actor_id == "xiaxi" else a for a in world.actors)
    records = []
    for index in range(3):
        age = rng.choice((0, 2, 8, 20))
        # 压力变量改变观测噪声，公开可靠度仍固定，用来暴露失准风险。
        correct = rng.random() < max(0.0, 0.85 - noise - age * 0.01)
        # 两种分支都抽取候选，噪声条件不会改变后续实例的随机调用位置。
        wrong_report = rng.choice([s for s in states if s != truth])
        report = truth if correct else wrong_report
        source = f"sensor-{index}"
        records.append(
            Observation(
                Evidence(
                    f"{seed}-{index}",
                    source,
                    f"origin-{index}",
                    frozenset({report}),
                    0.85,
                    20 - age,
                    20,
                ),
                "xiaxi",
                ("player",),
            )
        )
    # 原始事件的重复转述不能带来额外独立信息。
    original = records[0].evidence
    for copy in range(3):
        duplicate = replace(original, evidence_id=f"{seed}-copy-{copy}", source_id="forwarder")
        records.append(Observation(duplicate, "xiaxi", ("player",)))
    return replace(world, actors=actors, observations=tuple(records)), truth


def rule_benchmark():
    x, y, z = map(Var, ("x", "y", "z"))
    facts = {Atom("Edge", (i, i + 1)) for i in range(12)}
    facts |= {Atom("Irrelevant", (i,)) for i in range(250)}
    rules = (
        Rule("direct", Atom("Reach", (x, y)), (Atom("Edge", (x, y)),)),
        Rule("recursive", Atom("Reach", (x, z)), (Atom("Reach", (x, y)), Atom("Edge", (y, z)))),
    )
    outputs = {
        method: forward_chain(facts, rules, method=method) for method in ("naive", "semi_naive")
    }
    if outputs["naive"].facts != outputs["semi_naive"].facts:
        raise AssertionError("规则基线和优化版闭包不一致")
    return {
        "closure_equal": True,
        "fixture": "12-edge-chain-plus-250-irrelevant-facts",
        "methods": {method: result.metrics.as_dict() for method, result in outputs.items()},
    }


def run_benchmark(cases: int, output: str):
    if type(cases) is not int or not 1 <= cases <= 10000:
        raise ValueError("cases 必须为1到10000的整数")
    rows = []
    for noise in (0.0, 0.2, 0.4):
        for index in range(cases):
            seed = 100000 + index  # 相同实例跨噪声条件成对比较。
            world, truth = synthetic_case(seed, noise)
            started = perf_counter()
            result = analyze(observe(world, "player"))
            elapsed = perf_counter() - started
            models = {"bayes": result["bayes"], **result["evidence_methods"]}
            for method, record in models.items():
                probs = record["probabilities"]
                if probs:
                    prediction = min(probs, key=lambda state: (-probs[state], state))
                    brier = sum((probs[state] - (state == truth)) ** 2 for state in probs)
                    correct = prediction == truth
                else:
                    prediction, brier, correct = None, None, False
                rows.append(
                    {
                        "episode_id": seed,
                        "noise": noise,
                        "method": method,
                        "truth": truth,
                        "prediction": prediction,
                        "correct": correct,
                        "brier": brier,
                        "covered": bool(probs),
                        "all_methods_wall_seconds": elapsed,
                    }
                )
    summary = []
    for noise in (0.0, 0.2, 0.4):
        for method in ("bayes", "dempster", "yager"):
            subset = [r for r in rows if r["noise"] == noise and r["method"] == method]
            covered = [r for r in subset if r["covered"]]
            summary.append(
                {
                    "noise": noise,
                    "method": method,
                    "episodes": cases,
                    "coverage": len(covered) / cases,
                    "accuracy_all": mean(r["correct"] for r in subset),
                    "accuracy_covered": mean(r["correct"] for r in covered) if covered else None,
                    "brier_covered": mean(r["brier"] for r in covered) if covered else None,
                }
            )
    artifact = {
        "schema_version": 1,
        "status": "smoke_benchmark_not_final_research",
        "data_origin": "受控静态虚拟校园实例；未用于现实情感预测",
        "limitations": [
            "参数是设计值；训练、验证、测试轨迹和参数学习尚待完成",
            "噪声变体共享episode_id，不应作为独立样本计算置信区间",
            "贝叶斯模型是条件独立观测通道，尚未加入时间段/日程隐变量",
            "这里未评价动态任务完成率，也未实现期望信息价值策略",
        ],
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "pgmpy": version("pgmpy"),
            "numpy": version("numpy"),
        },
        "config": {
            "cases_per_noise": cases,
            "seeds_start": 100000,
            "source_reliability_design": 0.85,
            "tau_design_minutes": 20,
        },
        "rule_benchmark": rule_benchmark(),
        "summary": summary,
        "raw_rows": rows,
    }
    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    return {k: v for k, v in artifact.items() if k != "raw_rows"}
