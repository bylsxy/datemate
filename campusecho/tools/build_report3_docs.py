"""Build the CampusEcho report-three DOCX and PDF from docs/report3.md."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from lxml import etree
from pypdf import PdfReader

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT / "docs/report3.md"
DEFAULT_OUTPUT = PROJECT / "artifacts/report3/CampusEcho_校园回响报告.docx"
DEFAULT_FROZEN = PROJECT / "artifacts/kg/formal_test_20261118"
PANDOC_CANDIDATES = (
    Path("D:/Anaconda3/Library/bin/pandoc.exe"),
    Path("C:/Program Files/Pandoc/pandoc.exe"),
)
WORD_CANDIDATES = (
    Path("C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE"),
    Path("C:/Program Files (x86)/Microsoft Office/root/Office16/WINWORD.EXE"),
)
POPPLER_CANDIDATES = (
    Path(
        "C:/Users/徐阳/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe"
    ),
    Path(
        "C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1116-1220-0_26.1116.1220.0_x64__3k8sg7r9htsxt/dependencies/native/poppler/Library/bin/pdftoppm.exe"
    ),
)
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def find_tool(candidates, command):
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    resolved = shutil.which(command)
    return Path(resolved) if resolved else None


def _set_font(spec, name, size, bold=False):
    spec.font.name = "Times New Roman" if name == "宋体" else name
    spec.font.size = Pt(size)
    spec.font.bold = bold
    spec.font.italic = False
    spec.font.color.rgb = RGBColor(0, 0, 0)
    rp = (
        spec.element.get_or_add_rPr()
        if hasattr(spec, "element")
        else spec._element.get_or_add_rPr()
    )
    fonts = rp.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rp.insert(0, fonts)
    for attr, value in (("eastAsia", name), ("ascii", spec.font.name), ("hAnsi", spec.font.name)):
        fonts.set(qn("w:" + attr), value)
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        fonts.attrib.pop(qn("w:" + attr), None)


def _style(doc, name, face, size, bold=False, before=0, after=0):
    style = next((item for item in doc.styles if item.name == name), None)
    if style is None:
        raise KeyError(f"DOCX style not found: {name}")
    _set_font(style, face, size, bold)
    style.paragraph_format.space_before = Pt(before)
    style.paragraph_format.space_after = Pt(after)
    style.paragraph_format.line_spacing = 1.3
    if style.element.pPr is not None:
        for node in list(style.element.pPr):
            if node.tag in (qn("w:pBdr"), qn("w:shd")):
                style.element.pPr.remove(node)


def _page_field(paragraph):
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    paragraph._p.append(field)


def _cell_borders(cell):
    properties = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        element = OxmlElement("w:" + edge)
        for key, value in (("val", "single"), ("sz", "4"), ("color", "D9D9D9")):
            element.set(qn("w:" + key), value)
        borders.append(element)
    properties.append(borders)


def format_docx(path):
    doc = Document(path)
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(0.85)
    section.left_margin = section.right_margin = Inches(0.9)
    section.header_distance = section.footer_distance = Inches(0.35)
    _style(doc, "Normal", "宋体", 11.5, after=3)
    _style(doc, "Body Text", "宋体", 11.5, after=3)
    _style(doc, "First Paragraph", "宋体", 11.5, after=3)
    _style(doc, "Title", "黑体", 20, after=8)
    _style(doc, "Heading 1", "黑体", 15, before=12, after=6)
    _style(doc, "Heading 2", "黑体", 12.5, before=9, after=5)
    _style(doc, "Heading 3", "黑体", 11.5, before=7, after=4)
    _style(doc, "Caption", "宋体", 10.5, before=4, after=7)
    if "Image Caption" in doc.styles:
        _style(doc, "Image Caption", "宋体", 10.5, before=4, after=7)
    first_content = True
    for paragraph in doc.paragraphs:
        if first_content and paragraph.text.strip():
            paragraph.style = "Title"
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.first_line_indent = Pt(0)
            first_content = False
        elif paragraph.style.name == "Heading 2":
            paragraph.style = "Heading 1"
        elif paragraph.style.name == "Heading 3":
            paragraph.style = "Heading 2"
        if paragraph.style.name.startswith("Heading"):
            paragraph.paragraph_format.keep_with_next = True
            paragraph.paragraph_format.keep_together = True
            paragraph.paragraph_format.first_line_indent = Pt(0)
        elif paragraph.style.name in ("Normal", "Body Text", "First Paragraph"):
            paragraph.paragraph_format.first_line_indent = Pt(23)
        if paragraph.text.strip() == "第24组":
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.first_line_indent = Pt(0)
        if paragraph.text.startswith("关键词"):
            paragraph.paragraph_format.first_line_indent = Pt(0)
        if re.match(r"^\[\d+\]", paragraph.text):
            paragraph.paragraph_format.first_line_indent = Pt(0)
            paragraph.paragraph_format.space_before = Pt(0)
            paragraph.paragraph_format.space_after = Pt(1)
            paragraph.paragraph_format.line_spacing = 1.0
            for run in paragraph.runs:
                _set_font(run, "宋体", 9.5)
        if paragraph._p.xpath(".//m:oMathPara"):
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.first_line_indent = Pt(0)
            paragraph.paragraph_format.space_before = Pt(5)
            paragraph.paragraph_format.space_after = Pt(7)
            paragraph.paragraph_format.keep_together = True
        if paragraph._p.xpath(".//w:drawing"):
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.first_line_indent = Pt(0)
            paragraph.paragraph_format.keep_with_next = True
            paragraph.paragraph_format.space_after = Pt(0)
        if paragraph.style.name in ("Caption", "Image Caption"):
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            paragraph.paragraph_format.first_line_indent = Pt(0)
        paragraph.paragraph_format.widow_control = True
        for run in paragraph.runs:
            run.font.color.rgb = RGBColor(0, 0, 0)
    for shape in doc.inline_shapes:
        ratio = shape.height / shape.width
        shape.width = Inches(5.65)
        shape.height = int(shape.width * ratio)
        properties = shape._inline.docPr
        if not properties.get("descr"):
            properties.set("descr", "CampusEcho 知识图谱搜索研究图")
    for table in doc.tables:
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        if len(table.columns) == 7 and table.cell(0, 0).text.strip() == "方法":
            widths = [1.25, *([5.3 / 6] * 6)]
        else:
            widths = [6.55 / len(table.columns)] * len(table.columns)
        for index, column in enumerate(table.columns):
            column.width = Inches(widths[index])
        for row_index, row in enumerate(table.rows):
            if row_index == 0:
                row._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
            for column_index, cell in enumerate(row.cells):
                cell.width = Inches(widths[column_index])
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                _cell_borders(cell)
                for paragraph in cell.paragraphs:
                    paragraph.paragraph_format.first_line_indent = Pt(0)
                    paragraph.paragraph_format.space_after = Pt(0)
                    paragraph.alignment = (
                        WD_ALIGN_PARAGRAPH.LEFT if column_index == 0 else WD_ALIGN_PARAGRAPH.CENTER
                    )
                    for run in paragraph.runs:
                        _set_font(run, "宋体", 9.5, row_index == 0)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _page_field(footer)
    doc.core_properties.title = doc.paragraphs[0].text
    doc.core_properties.author = "第24组"
    doc.core_properties.subject = "CampusEcho 校园回响"
    doc.core_properties.keywords = "知识图谱 搜索 GA 分类器 LLM 校园互动"
    doc.save(path)


def inspect_docx(path):
    with ZipFile(path) as archive:
        root = etree.fromstring(archive.read("word/document.xml"))
        text = "".join(root.xpath("//w:t/text()", namespaces=NS))
        math = "".join(root.xpath("//m:t/text()", namespaces=NS))
        return {
            "chinese_characters": len(re.findall(r"[\u4e00-\u9fff]", text)),
            "all_text_characters": len(text),
            "math_characters": len(math),
            "native_math_objects": len(root.xpath("//m:oMath", namespaces=NS)),
            "display_equations": len(root.xpath("//m:oMathPara", namespaces=NS)),
            "images": len(root.xpath("//w:drawing", namespaces=NS)),
            "tables": len(root.xpath("//w:tbl", namespaces=NS)),
            "raw_latex_markers": re.findall(r"\\(?:frac|sum|theta|land|tag)\b", text),
        }


def build_docx(source, output, frozen_root, require_final=False):
    source = Path(source).resolve()
    output = Path(output).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"报告源文件不存在: {source}")
    pandoc = find_tool(PANDOC_CANDIDATES, "pandoc")
    if pandoc is None:
        raise RuntimeError("Pandoc 不可用，无法生成原生公式 DOCX")
    output.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(source)
    original = source.read_text(encoding="utf-8")
    frozen = json.loads((Path(frozen_root) / "summary.json").read_text(encoding="utf-8"))
    if frozen.get("status") != "complete":
        raise RuntimeError("冻结实验状态不是 complete")
    if require_final:
        if "第24组" not in original or "2026-11-18" not in original:
            raise RuntimeError("终稿缺少第24组或2026-11-18")
        if "LLM" in original and not any(
            marker in original
            for marker in ("待验证", "尚未验证", "待实网验证", "尚未形成正式对照")
        ):
            raise RuntimeError("终稿提到 LLM，但没有明确标注实网收益待验证")
    with tempfile.TemporaryDirectory(prefix="campusecho_report3_") as temp:
        pandoc_input = Path(temp) / "report3.pandoc.md"
        pandoc_input.write_text(
            re.sub(r"\\tag\{(\d+)\}", r"\\qquad \\mathrm{(\1)}", original), encoding="utf-8"
        )
        command = [
            str(pandoc),
            str(pandoc_input),
            "--from=markdown+tex_math_single_backslash+tex_math_dollars",
            "--to=docx",
            "--standalone",
            f"--resource-path={source.parent}",
            f"--output={output}",
        ]
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
        (output.parent / "pandoc.log").write_text(process.stdout + process.stderr, encoding="utf-8")
        if process.returncode != 0:
            raise RuntimeError("Pandoc 转换失败，请检查 pandoc.log")
        if "Could not convert" in process.stderr:
            raise RuntimeError("Pandoc 公式转换失败，请检查 pandoc.log")
    format_docx(output)
    if sha256(source) != source_hash:
        raise RuntimeError("构建期间报告源文件发生变化")
    stats = inspect_docx(output)
    if stats["raw_latex_markers"]:
        raise RuntimeError("DOCX 中残留原始 LaTeX 标记")
    expected_images = len(re.findall(r"!\[[^\]]*\]\([^)]+\)", original))
    if stats["images"] != expected_images:
        raise RuntimeError(
            f"DOCX 图片数与源稿不一致：应为 {expected_images} 张，实际 {stats['images']} 张"
        )
    return {
        "source": str(source),
        "source_sha256": source_hash,
        "docx": str(output),
        "docx_sha256": sha256(output),
        "pandoc": str(pandoc),
        "pandoc_native_math": True,
        "statistics": stats,
    }


def _word_export(docx, pdf, log):
    word = find_tool(WORD_CANDIDATES, "WINWORD.EXE")
    if word is None:
        raise RuntimeError("Microsoft Word 不可用")
    script = r"""param([string]$InputFile,[string]$OutputFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $document = $word.Documents.Open($InputFile, $false, $true, $false)
    $document.Fields.Update() | Out-Null
    $document.Repaginate()
    $pages = $document.ComputeStatistics(2)
    $document.ExportAsFixedFormat($OutputFile, 17)
    Write-Output ('WORD_PAGES=' + $pages)
} finally {
    if ($null -ne $document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($null -ne $word) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
"""
    with tempfile.TemporaryDirectory(prefix="campusecho_word3_") as temp:
        script_path = Path(temp) / "export.ps1"
        script_path.write_text(script, encoding="utf-8-sig")
        process = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script_path),
                "-InputFile",
                str(docx),
                "-OutputFile",
                str(pdf),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    log.write_text(process.stdout + process.stderr, encoding="utf-8")
    if process.returncode != 0 or not pdf.is_file():
        raise RuntimeError("Word 导出 PDF 失败，请检查 render/word_export.log")
    match = re.search(r"WORD_PAGES=(\d+)", process.stdout)
    if not match:
        raise RuntimeError("Word 未返回页数")
    return int(match.group(1))


def render_pdf(pdf, output, dpi=140):
    output.mkdir(parents=True, exist_ok=True)
    for old in output.glob("page-*.png"):
        old.unlink()
    poppler = find_tool(POPPLER_CANDIDATES, "pdftoppm")
    if poppler is None:
        raise RuntimeError("Poppler pdftoppm 不可用")
    process = subprocess.run(
        [str(poppler), "-png", "-r", str(dpi), str(pdf), str(output / "page")],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    (output / "pdftoppm.log").write_text(process.stdout + process.stderr, encoding="utf-8")
    if process.returncode != 0:
        raise RuntimeError("PDF 栅格化失败，请检查 pdftoppm.log")
    pages = sorted(output.glob("page-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
    count = len(PdfReader(pdf).pages)
    if len(pages) != count:
        raise RuntimeError("PNG 页数与 PDF 页数不一致")
    return pages, count


def frozen_completion_audit(frozen_root):
    records = []
    with (Path(frozen_root) / "records.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                records.append(json.loads(line))
    methods = ("bfs", "hand_astar", "ga_astar", "mcts", "ga_astar_classifier")
    audit = {}
    for method in methods:
        rows = [row for row in records if row.get("method") == method]
        complete = sum(bool(row.get("path_complete")) for row in rows)
        empty = sum(
            not row.get("path_complete") and int(row.get("predicted_path_count", -1)) == 0
            for row in rows
        )
        partial = len(rows) - complete - empty
        if (len(rows), complete, empty, partial) != (160, 21, 53, 86):
            raise RuntimeError(
                f"冻结记录构成异常: {method} = "
                f"total {len(rows)}, complete {complete}, empty {empty}, partial {partial}"
            )
        audit[method] = {
            "questions": len(rows),
            "complete": complete,
            "empty_valid": empty,
            "partial_valid": partial,
        }
    return audit


def build_documents(
    source=DEFAULT_SOURCE,
    output=DEFAULT_OUTPUT,
    frozen_root=DEFAULT_FROZEN,
    require_final=False,
    visual_review="pending",
):
    output = Path(output).resolve()
    docx_result = build_docx(source, output, frozen_root, require_final)
    pdf = output.with_suffix(".pdf")
    render_dir = output.parent / "render"
    render_dir.mkdir(parents=True, exist_ok=True)
    pages = _word_export(output, pdf, render_dir / "word_export.log")
    pngs, pdf_pages = render_pdf(pdf, render_dir)
    if pages != pdf_pages:
        raise RuntimeError("Word 页数与 PDF 页数不一致")
    text = re.sub(r"\s+", "", "".join(page.extract_text() or "" for page in PdfReader(pdf).pages))
    required = ("第24组", "2026-11-18", "LLM", "实网")
    missing = [value for value in required if value not in text]
    if missing:
        raise RuntimeError(f"PDF 缺少必要文本: {missing}")
    completion_audit = frozen_completion_audit(frozen_root)
    receipt = {
        "schema_version": 1,
        "built_at": datetime.now(UTC).isoformat(),
        "status": "complete",
        **docx_result,
        "pdf": str(pdf),
        "pdf_sha256": sha256(pdf),
        "pages": pages,
        "pngs": [
            {"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}
            for path in pngs
        ],
        "render": {
            "backend": "Microsoft Word COM ExportAsFixedFormat + Poppler",
            "dpi": 140,
            "visual_review": visual_review,
        },
        "frozen_record_audit": completion_audit,
        "required_pdf_text": list(required),
        "claim_boundaries": [
            "LLM 实网评分与解释完成验证；稳定收益仍需正式对照。",
            "冻结记录中 53 道无解题返回空集，86 道可解题返回非空真子集，21 道返回全部标准路径。",
        ],
    }
    (output.parent / "document_receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--frozen-root", type=Path, default=DEFAULT_FROZEN)
    parser.add_argument("--final", action="store_true")
    parser.add_argument(
        "--visual-review",
        choices=("pending", "complete"),
        default="pending",
        help="记录逐页渲染视觉复核状态",
    )
    args = parser.parse_args(argv)
    receipt = build_documents(
        args.source, args.output, args.frozen_root, args.final, args.visual_review
    )
    print(
        json.dumps(
            {
                "status": receipt["status"],
                "docx": receipt["docx"],
                "pdf": receipt["pdf"],
                "pages": receipt["pages"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
