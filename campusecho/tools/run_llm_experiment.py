"""Run a fixed-subset A* vs LLM-A* vs corrupted-LLM-A* comparison."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "src"))

from campusecho.kg_data import load_kg_data
from campusecho.kg_experiment import (
    ExperimentConfig,
    _label_map,
    run_search,
    score_prediction,
    stratified_sample,
)
from campusecho.llm_gateway import GatewayConfig, LLMGateway
from campusecho.llm_search import run_llm_astar


def _gateway(args: argparse.Namespace) -> LLMGateway:
    return LLMGateway(
        GatewayConfig(
            base_url=args.base_url,
            env_key=args.api_key_env,
            timeout=args.timeout,
            retries=0,
            cache_path=args.output / "llm-cache.json",
        )
    )


def _row(
    question,
    method: str,
    result,
    score: dict[str, object],
    *,
    usage=None,
) -> dict[str, object]:
    return {
        "question_id": question.question_id,
        "split": question.split,
        "min_hops": question.min_hops,
        "max_hops": question.max_hops,
        "method": method,
        "success": bool(score["success"]),
        "answer_correct": bool(score["answer_correct"]),
        "path_valid": bool(score["path_valid"]),
        "expanded_nodes": result.expanded_nodes,
        "candidate_checks": result.candidate_checks,
        "elapsed_seconds": result.search_elapsed_seconds,
        "llm_status": usage.status if usage is not None else "disabled",
        "llm_calls": usage.calls if usage is not None else 0,
        "llm_degraded_calls": usage.degraded_calls if usage is not None else 0,
        "llm_degraded_rate": usage.degrade_rate if usage is not None else 0.0,
        "llm_errors": list(usage.errors) if usage is not None else [],
    }


def _aggregate(rows, method: str) -> dict[str, object]:
    selected = [row for row in rows if row["method"] == method]
    return {
        "questions": len(selected),
        "success_rate": mean(bool(row["success"]) for row in selected),
        "mean_expanded_nodes": mean(row["expanded_nodes"] for row in selected),
        "mean_candidate_checks": mean(row["candidate_checks"] for row in selected),
        "mean_elapsed_seconds": mean(row["elapsed_seconds"] for row in selected),
        "llm_degraded_rate": (
            mean(row["llm_degraded_rate"] for row in selected)
            if method != "A*"
            else 0.0
        ),
        "mean_llm_calls": (
            mean(row["llm_calls"] for row in selected) if method != "A*" else 0.0
        ),
    }


def _write_outputs(output: Path, rows, summary) -> None:
    output.mkdir(parents=True, exist_ok=True)
    (output / "records.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    methods = ("A*", "LLM-A*", "LLM-A*-wrong")
    lines = [
        "# 固定子集 LLM-A* 对照",
        "",
        "| 方法 | 题数 | 成功率 | 平均扩展节点 | 平均候选检查 | 平均耗时/秒 | LLM 降级率 | 平均 LLM 调用 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for method in methods:
        row = summary["methods"][method]
        lines.append(
            f"| {method} | {row['questions']} | {row['success_rate']:.4f} | "
            f"{row['mean_expanded_nodes']:.3f} | {row['mean_candidate_checks']:.3f} | "
            f"{row['mean_elapsed_seconds']:.4f} | {row['llm_degraded_rate']:.4f} | "
            f"{row['mean_llm_calls']:.3f} |"
        )
    (output / "report_table.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = {
        "schema_version": 1,
        "status": "complete",
        "model": summary["model"],
        "files": {
            name: {
                "bytes": (output / name).stat().st_size,
                "sha256": hashlib.sha256((output / name).read_bytes()).hexdigest(),
            }
            for name in ("records.jsonl", "summary.json", "report_table.md")
        },
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    parser.add_argument("--api-key-env", default="CAMPUSECHO_LLM_KEY")
    parser.add_argument("--model", default="qwen2.5-0.5b-instruct-q4_k_m")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--max-llm-calls", type=int, default=6)
    parser.add_argument("--max-expansions", type=int, default=128)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--seed", type=int, default=20261118)
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT / "artifacts/kg/llm_compare_20261118",
    )
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)
    if args.output.exists() and any(args.output.iterdir()) and not args.overwrite:
        raise SystemExit(f"输出目录非空: {args.output}; 使用 --overwrite")

    data = load_kg_data(PROJECT / "data/kg", verify=True)
    questions = stratified_sample(
        (question for question in data.questions["core"] if question.split == "test"),
        limit=args.limit,
        seed=args.seed,
    )
    labels = _label_map(data, (question.question_id for question in questions))
    config = ExperimentConfig(
        split="test",
        limit=args.limit,
        max_expansions=args.max_expansions,
        mcts_simulations=0,
        rollout_depth=0,
        seed=args.seed,
        methods=("hand_astar",),
    )
    gateway = _gateway(args)
    rows: list[dict[str, object]] = []
    start = datetime.now(UTC)
    for question in questions:
        label = labels[question.question_id]
        baseline = run_search(question, data.graph, "hand_astar", config=config)
        baseline_score = score_prediction(baseline.paths, label)
        rows.append(_row(question, "A*", baseline, baseline_score))

        truthful = run_llm_astar(
            data,
            question,
            gateway,
            max_expansions=args.max_expansions,
            max_llm_calls=args.max_llm_calls,
            model=args.model,
        )
        rows.append(
            _row(question, "LLM-A*", truthful.search, score_prediction(truthful.search.paths, label), usage=truthful.usage)
        )

        # The wrong-reward condition keeps the same prompts and candidates but
        # inverts the model's selected branch. Cache is disabled here so its
        # wall-clock time remains comparable to the truthful run.
        corrupt = run_llm_astar(
            data,
            question,
            gateway,
            max_expansions=args.max_expansions,
            max_llm_calls=args.max_llm_calls,
            corruption="flip",
            model=args.model,
            use_cache=False,
        )
        rows.append(
            _row(question, "LLM-A*-wrong", corrupt.search, score_prediction(corrupt.search.paths, label), usage=corrupt.usage)
        )

    summary = {
        "schema_version": 1,
        "status": "complete",
        "generated_at": start.isoformat(),
        "model": Path(args.model).name or args.model,
        "model_path": str(args.model),
        "base_url": args.base_url,
        "seed": args.seed,
        "limit": args.limit,
        "max_llm_calls": args.max_llm_calls,
        "question_ids": [question.question_id for question in questions],
        "methods": {
            method: _aggregate(rows, method)
            for method in ("A*", "LLM-A*", "LLM-A*-wrong")
        },
    }
    _write_outputs(args.output, rows, summary)
    print(
        json.dumps(
            {
                "status": "complete",
                "records": len(rows),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
