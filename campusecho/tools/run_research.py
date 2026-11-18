"""从源码运行：python tools/run_research.py --output artifacts/research。"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from campusecho.research import ResearchConfig, resume_dynamic, run_research, supersede_dynamic


def main():
    parser = argparse.ArgumentParser(
        description="CampusEcho formal controlled-simulation experiments"
    )
    parser.add_argument("--output", default="artifacts/research")
    parser.add_argument("--seed", type=int, default=20261103)
    parser.add_argument("--bootstrap", type=int, default=500)
    parser.add_argument("--resume-dynamic", action="store_true")
    parser.add_argument("--approval-file")
    parser.add_argument("--archive-dynamic", action="store_true")
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="explicit non-formal validation in separate output directory",
    )
    args = parser.parse_args()
    if args.archive_dynamic:
        summary = supersede_dynamic(args.output)
        print(summary["status"])
        return
    if args.resume_dynamic:
        if not args.approval_file:
            parser.error(
                "--resume-dynamic requires --approval-file with explicit approved source hashes"
            )
        summary = resume_dynamic(args.output, approval_file=args.approval_file)
        print(summary["status"])
        return
    config = ResearchConfig(seed=args.seed, bootstrap=args.bootstrap)
    if args.smoke:
        if Path(args.output).as_posix().rstrip("/") == "artifacts/research":
            parser.error("--smoke requires a separate --output directory")
        config = ResearchConfig(
            seed=args.seed,
            train_episodes=12,
            val_episodes=6,
            test_episodes=6,
            calibration_episodes=3,
            robustness_episodes=3,
            sensitivity_episodes=3,
            dynamic_episodes=3,
            bootstrap=min(50, args.bootstrap),
        )
    summary = run_research(args.output, config)
    print(
        f"Finished: {summary['status']}; prediction rows={summary['raw_prediction_rows']}; "
        f"seconds={summary['elapsed_seconds']:.1f}"
    )


if __name__ == "__main__":
    main()
