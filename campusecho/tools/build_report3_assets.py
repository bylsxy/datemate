"""Build report-three figures exclusively from frozen CampusEcho results."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_FROZEN = PROJECT / "artifacts/kg/formal_test_20261118"
DEFAULT_OUTPUT = PROJECT / "artifacts/report3/figures"
EXPECTED_METHODS = ("bfs", "hand_astar", "ga_astar", "mcts", "ga_astar_classifier")
FIGURE_FILES = (
    "01_method_candidates.png",
    "02_answer_path_validity.png",
    "03_ga_weights.png",
    "04_ga_fitness.png",
    "05_classifier_calibration.png",
)
INK = "#1D2A32"
MUTED = "#667783"
GRID = "#DCE3E7"
PAPER = "#F7F9FA"


class FrozenDataError(RuntimeError):
    pass


@dataclass(frozen=True)
class FrozenResult:
    root: Path
    summary: dict[str, Any]
    parameters: dict[str, Any]
    protocol: dict[str, Any]
    report_table: dict[str, Any]
    manifest: dict[str, Any]
    records: tuple[dict[str, Any], ...]
    source_hashes: dict[str, str]

    @property
    def method_order(self):
        return tuple(self.summary["method_order"])

    @property
    def method_labels(self):
        return dict(self.summary["method_labels"])

    @property
    def test_rows(self):
        return {row["method"]: row for row in self.report_table["rows"] if row["split"] == "test"}


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise FrozenDataError(f"{path.name} must contain a JSON object")
    return value


def _read_records(path):
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise FrozenDataError(f"records.jsonl line {line_number} is not an object")
            rows.append(value)
    return tuple(rows)


def verify_frozen_manifest(root):
    manifest = _read_json(root / "freeze_manifest.json")
    if manifest.get("status") != "complete":
        raise FrozenDataError("The freeze manifest is not complete")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise FrozenDataError("The freeze manifest contains no file records")
    verified = {}
    for name, expected in files.items():
        if not isinstance(name, str) or Path(name).name != name:
            raise FrozenDataError(f"Invalid frozen filename: {name!r}")
        path = root / name
        if not path.is_file():
            raise FrozenDataError(f"Missing frozen file: {name}")
        actual_hash = _sha256(path)
        if not isinstance(expected, dict):
            raise FrozenDataError(f"Invalid frozen file record: {name}")
        if path.stat().st_size != expected.get("bytes"):
            raise FrozenDataError(f"Frozen file size changed: {name}")
        if actual_hash != expected.get("sha256"):
            raise FrozenDataError(f"Frozen file hash changed: {name}")
        verified[name] = actual_hash
    return verified


def load_frozen(root=DEFAULT_FROZEN):
    root = Path(root).resolve()
    hashes = verify_frozen_manifest(root)
    summary = _read_json(root / "summary.json")
    parameters = _read_json(root / "parameters.json")
    protocol = _read_json(root / "protocol.json")
    report_table = _read_json(root / "report_table.json")
    manifest = _read_json(root / "freeze_manifest.json")
    records = _read_records(root / "records.jsonl")
    if summary.get("status") != "complete" or summary.get("error_count") != 0:
        raise FrozenDataError("The formal experiment did not complete cleanly")
    if tuple(summary.get("method_order", ())) != EXPECTED_METHODS:
        raise FrozenDataError("Unexpected method order")
    if protocol.get("splits", {}).get("test_frozen") is not True:
        raise FrozenDataError("The protocol does not freeze the test split")
    metadata = parameters.get("metadata", {})
    if metadata.get("test_used_for_fit") is not False:
        raise FrozenDataError("The test split participated in fitting")
    if metadata.get("frozen_before_test") is not True:
        raise FrozenDataError("Parameters were not frozen before test")
    if metadata.get("ga_status") != "fitted" or metadata.get("classifier_status") != "fitted":
        raise FrozenDataError("GA or classifier did not fit successfully")
    if len(records) != summary.get("record_count"):
        raise FrozenDataError("Record count does not match the summary")
    if {row.get("method") for row in records} != set(EXPECTED_METHODS):
        raise FrozenDataError("The record methods do not match the protocol")
    aggregates = summary.get("aggregates", {}).get("test", {})
    rows = {
        row.get("method"): row for row in report_table.get("rows", []) if row.get("split") == "test"
    }
    if set(aggregates) != set(EXPECTED_METHODS) or set(rows) != set(EXPECTED_METHODS):
        raise FrozenDataError("Test aggregates or report rows are incomplete")
    for method in EXPECTED_METHODS:
        for field in (
            "answer_accuracy",
            "path_valid_rate",
            "path_complete_rate",
            "mean_candidate_checks",
            "mean_expanded_nodes",
        ):
            if not math.isclose(
                float(aggregates[method][field]),
                float(rows[method][field]),
                rel_tol=0,
                abs_tol=1e-12,
            ):
                raise FrozenDataError(f"Mismatch for {method}.{field}")
    ga = parameters.get("ga", {})
    if len(ga.get("feature_names", ())) != 4:
        raise FrozenDataError("GA does not have four features")
    if len(ga.get("initial_weights", ())) != 4 or len(ga.get("weights", ())) != 4:
        raise FrozenDataError("GA weight vectors are incomplete")
    if ga.get("config", {}).get("generations") != len(ga.get("generation_best_fitness", ())):
        raise FrozenDataError("GA generation count does not match its fitness curve")
    calibration = metadata.get("classifier_calibration", {})
    if calibration.get("sample_count") != calibration.get("positive_count", 0) + calibration.get(
        "negative_count", 0
    ):
        raise FrozenDataError("Classifier validation counts do not add up")
    if not 0 < float(parameters.get("classifier_threshold", 0)) < 1:
        raise FrozenDataError("Classifier threshold is invalid")
    return FrozenResult(
        root, summary, parameters, protocol, report_table, manifest, records, hashes
    )


def _font_family():
    available = {entry.name for entry in font_manager.fontManager.ttflist}
    for name in (
        "Microsoft YaHei",
        "SimHei",
        "Noto Sans CJK SC",
        "Source Han Sans SC",
        "Arial Unicode MS",
    ):
        if name in available:
            return name
    return "DejaVu Sans"


def _style():
    plt.rcParams.update(
        {
            "font.family": _font_family(),
            "font.size": 10.5,
            "axes.titlesize": 15,
            "axes.titleweight": "bold",
            "axes.labelsize": 10.5,
            "axes.labelcolor": INK,
            "axes.edgecolor": GRID,
            "axes.facecolor": PAPER,
            "figure.facecolor": "white",
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "text.color": INK,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "legend.frameon": False,
            "savefig.facecolor": "white",
        }
    )


def _finish(fig, path, note):
    fig.text(0.01, 0.012, note, ha="left", va="bottom", fontsize=8.2, color=MUTED)
    fig.savefig(path, dpi=220, bbox_inches="tight", pad_inches=0.16)
    plt.close(fig)
    if not path.is_file() or path.stat().st_size < 10000:
        raise FrozenDataError(f"Figure was not generated correctly: {path}")


def _write_csv(path, headers, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)


def plot_method_candidates(frozen, output):
    rows = frozen.test_rows
    methods = frozen.method_order
    labels = [frozen.method_labels[m] for m in methods]
    candidates = [float(rows[m]["mean_candidate_checks"]) for m in methods]
    expanded = [float(rows[m]["mean_expanded_nodes"]) for m in methods]
    x = np.arange(len(methods))
    fig, ax = plt.subplots(figsize=(9.2, 5.25))
    bars1 = ax.bar(x - 0.18, candidates, 0.36, color="#C66A4A", label="候选检查")
    bars2 = ax.bar(x + 0.18, expanded, 0.36, color="#526D82", label="扩展节点")
    ax.bar_label(bars1, fmt="%.2f", padding=3, fontsize=9, color="#8B3F2A")
    ax.bar_label(bars2, fmt="%.2f", padding=3, fontsize=9, color="#344B5C")
    ax.set_title("五种搜索策略的候选检查与扩展节点", loc="left")
    ax.set_ylabel("每题平均次数")
    ax.set_xticks(x, labels)
    ax.set_ylim(0, max(candidates + expanded) * 1.25)
    ax.grid(axis="y", alpha=0.75)
    ax.legend(loc="upper right", ncol=2)
    _finish(
        fig,
        output / FIGURE_FILES[0],
        f"冻结测试题 {int(rows[methods[0]]['questions'])} 道；数值自动读取冻结文件。",
    )
    return {
        "figure": FIGURE_FILES[0],
        "methods": list(methods),
        "mean_candidate_checks": candidates,
        "mean_expanded_nodes": expanded,
    }


def plot_answer_path(frozen, output):
    rows, methods = frozen.test_rows, frozen.method_order
    y = np.arange(len(methods))
    answer = np.array([float(rows[m]["answer_accuracy"]) for m in methods])
    valid = np.array([float(rows[m]["path_valid_rate"]) for m in methods])
    complete = np.array([float(rows[m]["path_complete_rate"]) for m in methods])
    fig, ax = plt.subplots(figsize=(9.2, 5.25))
    # 答案正确与路径有效在冻结结果中同为 100%，轻微错位并换标记避免完全遮挡。
    for values, color, label, marker, offset in (
        (answer, "#526D82", "答案正确", "o", 0.12),
        (valid, "#8A9A5B", "路径有效", "s", -0.12),
        (complete, "#C66A4A", "路径完整", "D", 0.0),
    ):
        positions = y + offset
        ax.scatter(values * 100, positions, s=90, marker=marker, color=color, label=label, zorder=3)
        for pos, value in zip(positions, values):
            ax.text(
                value * 100 + 1.2,
                pos,
                f"{value * 100:.2f}%",
                va="center",
                fontsize=8.8,
                color=color,
            )
    ax.set_title("答案正确与路径有效的评测口径", loc="left", pad=42)
    ax.set_xlabel("测试题比例（%）")
    ax.set_yticks(y, [frozen.method_labels[m] for m in methods])
    ax.set_xlim(0, 108)
    ax.grid(axis="x", alpha=0.75)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.01), ncol=3)
    _finish(fig, output / FIGURE_FILES[1], "路径完整率为 13.125%；答案正确与路径有效均为 100%。")
    return {
        "figure": FIGURE_FILES[1],
        "methods": list(methods),
        "answer_accuracy": answer.tolist(),
        "path_valid_rate": valid.tolist(),
        "path_complete_rate": complete.tolist(),
    }


def plot_ga_weights(frozen, output):
    ga = frozen.parameters["ga"]
    labels = {
        "goal_proximity": "目标接近",
        "evidence_support": "证据支持",
        "path_efficiency": "路径效率",
        "frontier_balance": "前沿平衡",
    }
    features = [labels.get(str(value), str(value)) for value in ga["feature_names"]]
    initial, final = np.asarray(ga["initial_weights"]), np.asarray(ga["weights"])
    x = np.arange(len(features))
    fig, ax = plt.subplots(figsize=(9.2, 5.25))
    bars1 = ax.bar(x - 0.18, initial, 0.36, color="#9AAAB3", label="初始权重")
    bars2 = ax.bar(x + 0.18, final, 0.36, color="#526D82", label="冻结权重")
    ax.bar_label(bars1, fmt="%.3f", padding=3, fontsize=8.8, color=MUTED)
    ax.bar_label(bars2, fmt="%.3f", padding=3, fontsize=8.8, color="#344B5C")
    ax.set_title("GA 启发权重的前后变化", loc="left")
    ax.set_ylabel("归一化权重")
    ax.set_xticks(x, features, rotation=12, ha="right")
    ax.set_ylim(0, max(initial.max(), final.max()) * 1.24)
    ax.grid(axis="y", alpha=0.75)
    ax.legend(loc="upper right", ncol=2)
    _finish(fig, output / FIGURE_FILES[2], "权重读取自冻结 parameters.json。")
    return {
        "figure": FIGURE_FILES[2],
        "features": features,
        "initial_weights": initial.tolist(),
        "final_weights": final.tolist(),
    }


def plot_ga_fitness(frozen, output):
    ga = frozen.parameters["ga"]
    curve = np.asarray(ga["generation_best_fitness"])
    if curve.ndim != 2 or curve.shape[1] != 3:
        raise FrozenDataError("GA fitness curve is not N x 3")
    generations = np.arange(1, len(curve) + 1)
    fig, ax = plt.subplots(figsize=(9.2, 5.25))
    ax.plot(generations, curve[:, 0], marker="o", color="#526D82", label="成功率")
    ax.plot(generations, curve[:, 1], marker="s", color="#C66A4A", label="−平均扩展节点")
    ax.plot(generations, curve[:, 2], marker="^", color="#8A9A5B", label="−平均步数")
    ax.set_title("GA 各代最优 fitness 分量", loc="left")
    ax.set_xlabel("代")
    ax.set_ylabel("fitness 分量")
    ax.set_xticks(generations)
    ax.grid(axis="y", alpha=0.75)
    ax.legend(loc="center right", ncol=1)
    for series, color in zip(curve.T, ("#526D82", "#C66A4A", "#8A9A5B")):
        ax.annotate(
            f"{series[-1]:.3f}",
            (generations[-1], series[-1]),
            xytext=(6, 0),
            textcoords="offset points",
            va="center",
            fontsize=8.8,
            color=color,
        )
    _finish(
        fig, output / FIGURE_FILES[3], "曲线读取自 parameters.json；后两项按 fitness 定义取负显示。"
    )
    return {
        "figure": FIGURE_FILES[3],
        "generations": generations.tolist(),
        "best_fitness": curve.tolist(),
    }


def plot_classifier_calibration(frozen, output):
    calibration = frozen.parameters["metadata"]["classifier_calibration"]
    threshold = float(frozen.parameters["classifier_threshold"])
    positive, negative = int(calibration["positive_count"]), int(calibration["negative_count"])
    fig, (ax1, ax2) = plt.subplots(
        1, 2, figsize=(9.2, 5.25), gridspec_kw={"width_ratios": [1.2, 1]}
    )
    bars = ax1.bar(
        ["正类前缀", "负类前缀"], [positive, negative], color=["#526D82", "#C66A4A"], width=0.55
    )
    ax1.bar_label(bars, padding=4, fontsize=10)
    ax1.set_title("验证集校准样本支持", loc="left")
    ax1.set_ylabel("样本数")
    ax1.set_ylim(0, positive * 1.18)
    ax1.grid(axis="y", alpha=0.75)
    ax2.axvspan(0, threshold, color="#E7ECEF", alpha=0.85)
    ax2.axvspan(threshold, 1, color="#F3E4DE", alpha=0.85)
    ax2.axvline(threshold, color="#C66A4A", linewidth=2.5)
    ax2.text(
        threshold + 0.025,
        0.65,
        f"冻结阈值 {threshold:.2f}",
        color="#8B3F2A",
        fontsize=11,
        weight="bold",
    )
    ax2.text(threshold / 2, 0.27, "低于阈值", ha="center", color=MUTED)
    ax2.text((threshold + 1) / 2, 0.27, "达到阈值", ha="center", color=MUTED)
    ax2.set_xlim(0, 1)
    ax2.set_ylim(0, 1)
    ax2.set_xticks([0, 0.2, 0.4, 0.6, 0.8, 1])
    ax2.set_yticks([])
    ax2.set_xlabel("路径分类概率")
    ax2.set_title("验证集阈值来源", loc="left")
    fig.suptitle(
        f"分类器在验证集冻结：{positive + negative} 个样本，阈值 {threshold:.2f}",
        x=0.06,
        ha="left",
        fontsize=15,
        weight="bold",
    )
    fig.subplots_adjust(top=0.80, wspace=0.24)
    _finish(
        fig,
        output / FIGURE_FILES[4],
        f"来源：冻结参数 {calibration['source']}；冻结包未保存完整混淆矩阵。",
    )
    return {
        "figure": FIGURE_FILES[4],
        "threshold": threshold,
        "source": calibration["source"],
        "positive_count": positive,
        "negative_count": negative,
        "sample_count": positive + negative,
    }


def build_assets(frozen_root=DEFAULT_FROZEN, output=DEFAULT_OUTPUT):
    frozen = load_frozen(frozen_root)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    _style()
    plots = [
        plot_method_candidates(frozen, output),
        plot_answer_path(frozen, output),
        plot_ga_weights(frozen, output),
        plot_ga_fitness(frozen, output),
        plot_classifier_calibration(frozen, output),
    ]
    rows, methods = frozen.test_rows, frozen.method_order
    _write_csv(
        output / "01_method_candidates.csv",
        ["method", "method_label", "mean_candidate_checks", "mean_expanded_nodes"],
        [
            [
                m,
                frozen.method_labels[m],
                rows[m]["mean_candidate_checks"],
                rows[m]["mean_expanded_nodes"],
            ]
            for m in methods
        ],
    )
    _write_csv(
        output / "02_answer_path_validity.csv",
        ["method", "method_label", "answer_accuracy", "path_valid_rate", "path_complete_rate"],
        [
            [
                m,
                frozen.method_labels[m],
                rows[m]["answer_accuracy"],
                rows[m]["path_valid_rate"],
                rows[m]["path_complete_rate"],
            ]
            for m in methods
        ],
    )
    ga = frozen.parameters["ga"]
    _write_csv(
        output / "03_ga_weights.csv",
        ["feature", "initial_weight", "final_weight"],
        [[f, i, n] for f, i, n in zip(ga["feature_names"], ga["initial_weights"], ga["weights"])],
    )
    _write_csv(
        output / "04_ga_fitness.csv",
        ["generation", "success_rate", "negative_mean_expanded_nodes", "negative_mean_steps"],
        [[i, *v] for i, v in enumerate(ga["generation_best_fitness"], 1)],
    )
    c = frozen.parameters["metadata"]["classifier_calibration"]
    _write_csv(
        output / "05_classifier_calibration.csv",
        ["item", "value"],
        [
            ["threshold", frozen.parameters["classifier_threshold"]],
            ["source", c["source"]],
            ["positive_count", c["positive_count"]],
            ["negative_count", c["negative_count"]],
            ["sample_count", c["sample_count"]],
        ],
    )
    receipt = {
        "schema_version": 1,
        "built_at": datetime.now(UTC).isoformat(),
        "status": "complete",
        "frozen_root": str(frozen.root),
        "frozen_files": frozen.source_hashes,
        "output": str(output),
        "figures": [
            {
                "path": str(output / n),
                "sha256": _sha256(output / n),
                "bytes": (output / n).stat().st_size,
            }
            for n in FIGURE_FILES
        ],
        "data": plots,
        "claim_boundaries": [
            "Figures use only formal_test_20261118.",
            "The classifier figure reports validation counts and threshold provenance.",
            "No LLM scores were recorded; report three must not claim an LLM benefit.",
        ],
    }
    (output / "asset_receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--frozen-root", type=Path, default=DEFAULT_FROZEN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args(argv)
    receipt = build_assets(args.frozen_root, args.output)
    print(
        json.dumps(
            {
                "status": receipt["status"],
                "figures": len(receipt["figures"]),
                "output": receipt["output"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
