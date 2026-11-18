"""Tests for report-three figures, presentation, and document builders."""

from __future__ import annotations

import sys
from pathlib import Path
from zipfile import ZipFile

import pytest
from PIL import Image
from pptx import Presentation

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "tools"))

from build_report3_assets import FIGURE_FILES, build_assets, load_frozen
from build_report3_docs import build_documents, build_docx, inspect_docx
from build_report3_ppt import (
    GROUP,
    MEMBERS,
    REPORT_DATE,
    build_presentation,
    inspect_presentation,
)

FROZEN = PROJECT / "artifacts/kg/formal_test_20261118"


def test_frozen_results_are_complete_and_cross_consistent():
    frozen = load_frozen(FROZEN)
    assert frozen.summary["status"] == "complete"
    assert frozen.summary["error_count"] == 0
    assert frozen.summary["question_counts"]["test"] == 160
    assert frozen.summary["record_count"] == 800
    assert len(frozen.records) == 800
    assert frozen.parameters["metadata"]["test_used_for_fit"] is False
    assert frozen.parameters["metadata"]["frozen_before_test"] is True
    rows = frozen.test_rows
    assert rows["bfs"]["mean_candidate_checks"] == pytest.approx(8.45625)
    assert rows["ga_astar"]["mean_candidate_checks"] == pytest.approx(5.2125)
    assert rows["ga_astar_classifier"]["mean_expanded_nodes"] == pytest.approx(3.2)
    assert rows["bfs"]["path_complete_rate"] == pytest.approx(0.13125)
    assert frozen.parameters["classifier_threshold"] == pytest.approx(0.8)
    assert frozen.parameters["metadata"]["classifier_calibration"]["sample_count"] == 2461
    assert frozen.summary["aggregates"]["test"]["bfs"]["llm_scored"] == 0


def test_report_failure_breakdown_matches_frozen_records():
    frozen = load_frozen(FROZEN)
    report = (PROJECT / "docs/report3.md").read_text(encoding="utf-8")
    for method in frozen.method_order:
        rows = [row for row in frozen.records if row["method"] == method]
        assert len(rows) == 160
        assert all(row["success"] for row in rows)
        assert sum(not row["path_complete"] for row in rows) == 139
        assert sum(not row["predicted_paths"] for row in rows) == 53
        assert sum(bool(row["predicted_paths"]) for row in rows) == 107
        assert sum(
            bool(row["predicted_paths"]) and not row["path_complete"] for row in rows
        ) == 86
    assert "107 道可解题" in report
    assert "53 道无解题" in report
    assert "86 道可解题" in report
    assert "冻结记录中没有“可解但没有返回路径”的题" in report


def test_frozen_manifest_rejects_content_change(tmp_path):
    frozen_copy = tmp_path / "frozen"
    frozen_copy.mkdir()
    for source in FROZEN.iterdir():
        if source.is_file():
            (frozen_copy / source.name).write_bytes(source.read_bytes())
    metrics = frozen_copy / "metrics.csv"
    metrics.write_bytes(metrics.read_bytes() + b"\n")
    with pytest.raises(RuntimeError, match="size changed|hash changed"):
        load_frozen(frozen_copy)


def test_report_table_matches_frozen_numbers():
    frozen = load_frozen(FROZEN)
    report = (PROJECT / "docs/report3.md").read_text(encoding="utf-8")
    method_ids = {frozen.method_labels[method]: method for method in frozen.method_order}
    parsed = {}
    for line in report.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        label = cells[0].replace("\\*", "*") if cells else ""
        if len(cells) != 7 or label not in method_ids:
            continue
        parsed[method_ids[label]] = {
            "answer_accuracy": float(cells[1]),
            "path_valid_rate": float(cells[2]),
            "path_complete_rate": float(cells[3]),
            "mean_expanded_nodes": float(cells[4]),
            "mean_candidate_checks": float(cells[5]),
            "mean_elapsed_seconds": float(cells[6]),
        }
    assert set(parsed) == set(frozen.method_order)
    for method, values in parsed.items():
        for field, value in values.items():
            # 报告耗时按 8 位小数展示，允许半个末位的舍入误差。
            tolerance = 5e-9 if field == "mean_elapsed_seconds" else 1e-12
            assert value == pytest.approx(float(frozen.test_rows[method][field]), abs=tolerance)


def test_report_explains_frozen_completion_composition():
    frozen = load_frozen(FROZEN)
    report = (PROJECT / "docs/report3.md").read_text(encoding="utf-8")
    for method in frozen.method_order:
        rows = [row for row in frozen.records if row["method"] == method]
        complete = [row for row in rows if row["path_complete"]]
        empty = [
            row
            for row in rows
            if not row["path_complete"] and row["predicted_path_count"] == 0
        ]
        partial = [
            row
            for row in rows
            if not row["path_complete"] and row["predicted_path_count"] > 0
        ]
        assert (len(complete), len(empty), len(partial)) == (21, 53, 86)
        assert all(row["path_valid"] and row["success"] for row in rows)
        assert all(row["answer_correct"] for row in empty)
        assert all(row["predicted_answer_count"] == 0 for row in empty)
        assert all(row["path_valid"] for row in partial)
    assert "53 道无解题" in report
    assert "86 道可解题" in report
    assert "冻结记录中没有“可解但没有返回路径”的题。" in report


def test_build_assets_creates_five_research_figures(tmp_path):
    output = tmp_path / "figures"
    receipt = build_assets(FROZEN, output)
    assert receipt["status"] == "complete"
    assert len(receipt["figures"]) == 5
    assert tuple(Path(item["path"]).name for item in receipt["figures"]) == FIGURE_FILES
    for name in FIGURE_FILES:
        path = output / name
        assert path.is_file()
        assert path.stat().st_size > 20_000
        with Image.open(path) as image:
            assert image.format == "PNG"
            assert image.width >= 1600
            assert image.height >= 900
    data = receipt["data"]
    assert data[0]["mean_candidate_checks"][0] == pytest.approx(8.45625)
    assert data[1]["path_complete_rate"][0] == pytest.approx(0.13125)
    assert data[2]["final_weights"] == pytest.approx(
        load_frozen(FROZEN).parameters["ga"]["weights"]
    )
    assert data[3]["best_fitness"][-1] == pytest.approx(
        load_frozen(FROZEN).parameters["ga"]["best_fitness"]
    )
    assert data[4]["sample_count"] == 2461


def test_ppt_has_six_slides_required_text_and_sixteen_by_nine(tmp_path):
    output = tmp_path / "deck.pptx"
    receipt = build_presentation(output, FROZEN)
    assert receipt["status"] == "complete"
    prs = Presentation(output)
    assert len(prs.slides) == 6
    assert prs.slide_width / 914400 == pytest.approx(13.333333, abs=1e-4)
    assert prs.slide_height / 914400 == pytest.approx(7.5)
    text = "\n".join(
        shape.text for slide in prs.slides for shape in slide.shapes if hasattr(shape, "text")
    )
    for value in (
        "CampusEcho",
        GROUP,
        REPORT_DATE,
        *MEMBERS,
        "官方 DeepSeek 已完成真实评分与解释验证",
        "正式冻结实验未混入 LLM",
        "稳定收益仍需正式对照",
    ):
        assert value in text
    for value in (
        "报告三",
        "报告编号",
        "套壳",
        "第91组",
        "LLM 评分为 0 条",
        "实网调用与收益仍待验证",
        "实网 LLM 收益尚未验证",
    ):
        assert value not in text
    notes = "\n".join(
        slide.notes_slide.notes_text_frame.text
        for slide in prs.slides
        if slide.has_notes_slide
    )
    for value in (
        "LLM 评分为 0 条",
        "实网调用与收益仍待验证",
        "实网 LLM 收益尚未验证",
    ):
        assert value not in notes
    assert "5.21" in text and "3.20" in text and "13.125%" in text
    assert inspect_presentation(output)["slides"] == 6


def test_docx_builder_uses_pandoc_native_math_and_report_identity(tmp_path):
    figures = tmp_path / "figures"
    build_assets(FROZEN, figures)
    source = tmp_path / "report3.md"
    source.write_text(
        "# CampusEcho 校园回响\n\n第24组\n\n2026-11-18\n\n"
        "## 摘要\n\n本文使用冻结实验。LLM 实网调用与收益待验证。\n\n"
        "## 方法\n\n设路径权重为 $w=(w_1,w_2,w_3,w_4)$，fitness 为\n\n"
        "$$\nF=(s,-\\bar{n},-\\bar{d}).\\tag{1}\n$$\n\n"
        f"![搜索图]({(figures / FIGURE_FILES[0]).as_posix()})\n\n"
        "| 方法 | 候选检查 |\n| --- | --- |\n| BFS | 8.45625 |\n| GA-A* | 5.2125 |\n",
        encoding="utf-8",
    )
    output = tmp_path / "report3.docx"
    receipt = build_docx(source, output, FROZEN, require_final=True)
    stats = inspect_docx(output)
    assert receipt["pandoc_native_math"] is True
    assert stats["native_math_objects"] >= 2
    assert stats["display_equations"] >= 1
    assert stats["images"] >= 1
    assert stats["tables"] == 1
    assert stats["raw_latex_markers"] == []
    with ZipFile(output) as archive:
        xml = archive.read("word/document.xml")
    assert "第24组".encode() in xml
    assert b"2026-11-18" in xml
    assert b"<m:oMath" in xml


def test_docx_final_gate_rejects_missing_llm_boundary(tmp_path):
    source = tmp_path / "report3.md"
    source.write_text(
        "# CampusEcho 校园回响\n\n第24组\n\n2026-11-18\n\nLLM 已带来收益。\n", encoding="utf-8"
    )
    with pytest.raises(RuntimeError, match="待验证"):
        build_docx(source, tmp_path / "bad.docx", FROZEN, require_final=True)


def test_document_receipt_records_visual_review(tmp_path, monkeypatch):
    source = tmp_path / "report3.md"
    source.write_text(
        "# CampusEcho 校园回响\n\n第24组\n\n2026-11-18\n\nLLM 实网调用与收益待验证。\n",
        encoding="utf-8",
    )
    output = tmp_path / "report3.docx"
    png = tmp_path / "render" / "page-01.png"
    png.parent.mkdir()
    png.write_bytes(b"rendered")
    monkeypatch.setattr(
        "build_report3_docs.build_docx",
        lambda *_args, **_kwargs: {
            "source": str(source),
            "source_sha256": "source",
            "docx": str(output),
            "docx_sha256": "docx",
        },
    )

    def fake_word_export(_docx, pdf, _log):
        Path(pdf).write_bytes(b"pdf")
        return 1

    monkeypatch.setattr("build_report3_docs._word_export", fake_word_export)
    monkeypatch.setattr("build_report3_docs.render_pdf", lambda *_args: ([png], 1))

    class FakePage:
        def extract_text(self):
            return "第24组 2026-11-18 LLM 实网"

    class FakeReader:
        def __init__(self):
            self.pages = [FakePage()]

    monkeypatch.setattr("build_report3_docs.PdfReader", lambda *_args: FakeReader())
    receipt = build_documents(source, output, FROZEN, visual_review="complete")
    assert receipt["render"]["visual_review"] == "complete"
    assert receipt["frozen_record_audit"]["bfs"] == {
        "questions": 160,
        "complete": 21,
        "empty_valid": 53,
        "partial_valid": 86,
    }
    saved = (tmp_path / "document_receipt.json").read_text(encoding="utf-8")
    assert '"visual_review": "complete"' in saved
