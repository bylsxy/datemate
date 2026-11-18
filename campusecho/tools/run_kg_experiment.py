"""运行 CampusEcho 知识图谱正式对比实验并写出冻结结果。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "src"))

from campusecho.kg_data import load_kg_data
from campusecho.kg_experiment import (
    METHODS,
    ExperimentConfig,
    run_experiment,
    write_experiment_outputs,
)


def _methods(value: str) -> tuple[str, ...]:
    methods = tuple(item.strip() for item in value.split(",") if item.strip())
    unknown = sorted(set(methods) - set(METHODS))
    if unknown:
        raise argparse.ArgumentTypeError(
            f"未知方法 {unknown}; 可选值: {', '.join(METHODS)}"
        )
    if not methods:
        raise argparse.ArgumentTypeError("至少指定一个方法")
    if len(set(methods)) != len(methods):
        raise argparse.ArgumentTypeError("方法不能重复")
    return methods


def _seeds(value: str) -> tuple[int, ...]:
    try:
        seeds = tuple(int(item.strip()) for item in value.split(",") if item.strip())
    except ValueError as exc:
        raise argparse.ArgumentTypeError("GA 种子必须是逗号分隔的整数") from exc
    if not seeds:
        raise argparse.ArgumentTypeError("至少指定一个 GA 种子")
    if len(set(seeds)) != len(seeds):
        raise argparse.ArgumentTypeError("GA 种子不能重复")
    return seeds


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="CampusEcho KG 对比实验；默认输出到新的冻结目录，拒绝覆盖。"
    )
    parser.add_argument("--data-dir", type=Path, default=PROJECT / "data/kg")
    parser.add_argument("--output", type=Path, default=PROJECT / "artifacts/kg_experiment")
    parser.add_argument("--split", choices=("train", "val", "test", "all"), default="test")
    parser.add_argument(
        "--limit",
        type=int,
        help="评测 split 的固定分层抽样上限；--split all 时每个 split 分别应用",
    )
    parser.add_argument(
        "--fit-limit",
        type=int,
        help="train/val 各自参与拟合的固定分层抽样上限",
    )
    parser.add_argument(
        "--methods",
        type=_methods,
        default=METHODS,
        help="逗号分隔: bfs,hand_astar,ga_astar,mcts,ga_astar_classifier",
    )
    parser.add_argument("--seed", type=int, default=20261118)
    parser.add_argument("--llm-subset-limit", type=int, default=60)
    parser.add_argument("--max-expansions", type=int, default=10_000)
    parser.add_argument("--max-candidate-checks", type=int)
    parser.add_argument("--mcts-simulations", type=int, default=1_000)
    parser.add_argument("--rollout-depth", type=int, default=8)
    parser.add_argument("--ga-population", type=int, default=12)
    parser.add_argument("--ga-generations", type=int, default=8)
    parser.add_argument("--classifier-epochs", type=int, default=600)
    parser.add_argument("--classifier-prefix-limit", type=int, default=100_000)
    parser.add_argument(
        "--ga-seeds",
        type=_seeds,
        default=(20261118,),
        help="逗号分隔的 GA 随机种子",
    )
    parser.add_argument("--classifier-threshold", type=float)
    parser.add_argument(
        "--include-private-labels",
        action="store_true",
        help="在逐题输出中附上私有标准答案；默认不写入",
    )
    parser.add_argument("--overwrite", action="store_true", help="允许覆盖已有输出")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    data = load_kg_data(args.data_dir, verify=True)
    config = ExperimentConfig(
        split=args.split,
        limit=args.limit,
        fit_limit=args.fit_limit,
        methods=args.methods,
        seed=args.seed,
        llm_subset_limit=args.llm_subset_limit,
        max_expansions=args.max_expansions,
        max_candidate_checks=args.max_candidate_checks,
        mcts_simulations=args.mcts_simulations,
        rollout_depth=args.rollout_depth,
        ga_population_size=args.ga_population,
        ga_generations=args.ga_generations,
        ga_seeds=args.ga_seeds,
        classifier_epochs=args.classifier_epochs,
        classifier_threshold=args.classifier_threshold,
        classifier_prefix_limit=args.classifier_prefix_limit,
        include_private_labels=args.include_private_labels,
    )
    result = run_experiment(data, config, data_dir=args.data_dir)
    output = write_experiment_outputs(result, args.output, overwrite=args.overwrite)
    print(
        json.dumps(
            {
                "status": result.summary["status"],
                "output": str(output),
                "records": result.summary["record_count"],
                "duration_seconds": result.summary["duration_seconds"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
