import argparse
import json

from .engine import analyze
from .world import observe, scenario


def main():
    parser = argparse.ArgumentParser(description="CampusEcho 校园推理机制实验")
    sub = parser.add_subparsers(dest="command", required=True)
    demo = sub.add_parser("demo", help="输出一个机制案例的真实推理结果")
    demo.add_argument(
        "--scenario", choices=["conflict", "duplicate", "umbrella"], default="conflict"
    )
    server = sub.add_parser("serve", help="启动本地实验台")
    server.add_argument("--port", type=int, default=8842)
    bench = sub.add_parser("benchmark", help="运行初步受控仿真基准")
    bench.add_argument("--cases", type=int, default=30)
    bench.add_argument("--output", default="artifacts/smoke_metrics.json")
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run("campusecho.api:app", host="127.0.0.1", port=args.port)
    elif args.command == "benchmark":
        from .benchmark import run_benchmark

        result = run_benchmark(args.cases, args.output)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            json.dumps(
                analyze(observe(scenario(args.scenario), "player")), ensure_ascii=False, indent=2
            )
        )


if __name__ == "__main__":
    main()
