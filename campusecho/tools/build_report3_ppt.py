"""Build the six-slide CampusEcho report-three presentation with python-pptx."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from build_report3_assets import DEFAULT_FROZEN, build_assets, load_frozen
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT / "artifacts/report3/CampusEcho_两分钟汇报.pptx"
DEFAULT_FIGURES = PROJECT / "artifacts/report3/figures"
GROUP = "第24组"
REPORT_DATE = "2026-11-18"
MEMBERS = ("徐阳", "廖信同", "黎欣欣", "周艳雯", "殷浚峰")
SLIDE_TITLES = (
    "问题与关系图谱",
    "统一搜索空间",
    "BFS、A* 与 MCTS",
    "GA 与路径分类器结果",
    "LLM 受限职责与幻觉防护",
    "校园任务闭环与成员",
)
INK = RGBColor(29, 42, 50)
MUTED = RGBColor(102, 119, 131)
PAPER = RGBColor(247, 249, 250)
WHITE = RGBColor(255, 255, 255)
NAVY = RGBColor(65, 87, 104)
TEAL = RGBColor(72, 127, 124)
RUST = RGBColor(198, 106, 74)
SAGE = RGBColor(138, 154, 91)
LINE = RGBColor(220, 227, 231)
FONT = "Microsoft YaHei"


def _set_text(shape, text, size, color=INK, bold=False, align=PP_ALIGN.LEFT):
    frame = shape.text_frame
    frame.clear()
    frame.word_wrap = True
    frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = 0
    frame.vertical_anchor = MSO_ANCHOR.TOP
    paragraph = frame.paragraphs[0]
    paragraph.alignment = align
    paragraph.space_before = paragraph.space_after = Pt(0)
    run = paragraph.add_run()
    run.text = text
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color


def _text(slide, left, top, width, height, value, size, color=INK, bold=False, align=PP_ALIGN.LEFT):
    shape = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    _set_text(shape, value, size, color, bold, align)
    return shape


def _rect(slide, left, top, width, height, fill, line=None, radius=False):
    geometry = MSO_AUTO_SHAPE_TYPE.ROUNDED_RECTANGLE if radius else MSO_AUTO_SHAPE_TYPE.RECTANGLE
    shape = slide.shapes.add_shape(
        geometry, Inches(left), Inches(top), Inches(width), Inches(height)
    )
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    shape.line.color.rgb = line or fill
    return shape


def _label(slide, left, top, width, value, fill=WHITE, color=INK, size=12):
    shape = _rect(slide, left, top, width, 0.48, fill, LINE, True)
    _set_text(shape, value, size, color, True, PP_ALIGN.CENTER)


def _base(prs, title, number):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = WHITE
    _text(slide, 0.62, 0.34, 11.7, 0.58, title, 27, bold=True)
    _rect(slide, 0.62, 1.08, 12.05, 0.018, LINE)
    _text(
        slide,
        0.65,
        7.08,
        9.7,
        0.24,
        f"CampusEcho 校园回响  |  {GROUP}  |  {REPORT_DATE}",
        9.5,
        MUTED,
    )
    _text(slide, 11.92, 7.06, 0.70, 0.24, f"{number:02d}", 9.5, MUTED, align=PP_ALIGN.RIGHT)
    return slide


def _metric(slide, left, top, value, caption):
    _text(slide, left, top, 1.85, 0.58, value, 27, NAVY, True)
    _text(slide, left, top + 0.58, 1.85, 0.44, caption, 10, MUTED)


def _image(slide, path, left, top, width):
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    with Image.open(path) as image:
        image.verify()
    slide.shapes.add_picture(str(path), Inches(left), Inches(top), width=Inches(width))


def _notes(slide, value):
    slide.notes_slide.notes_text_frame.text = value


def _slide_problem(prs, frozen):
    slide = _base(prs, SLIDE_TITLES[0], 1)
    _text(
        slide,
        0.72,
        1.42,
        4.25,
        1.05,
        "角色只掌握局部、过期或重复的线索，却仍要在截止前选择行动",
        20,
        bold=True,
    )
    _text(
        slide,
        0.72,
        2.75,
        4.35,
        1.65,
        "世界真值与角色视图分离。搜索结果给出答案、路径和依据，动作再由本地执行器检查前置条件。",
        14.2,
        MUTED,
    )
    _metric(slide, 0.72, 4.90, str(frozen.summary["question_counts"]["test"]), "冻结测试题")
    _metric(slide, 2.72, 4.90, str(len(frozen.method_order)), "对照策略")
    _metric(slide, 4.72, 4.90, str(frozen.summary["record_count"]), "逐例记录")
    nodes = [
        (7.12, 1.72, "角色", NAVY),
        (9.15, 1.28, "线索", TEAL),
        (11.05, 1.72, "来源", SAGE),
        (7.12, 3.56, "任务", RUST),
        (9.15, 4.12, "地点", NAVY),
        (11.05, 3.56, "动作", TEAL),
    ]
    for start, end in ((0, 1), (1, 2), (0, 3), (3, 4), (4, 5), (1, 4), (2, 5)):
        x1, y1, _, _ = nodes[start]
        x2, y2, _, _ = nodes[end]
        line = slide.shapes.add_connector(
            1, Inches(x1 + 0.56), Inches(y1 + 0.32), Inches(x2 + 0.56), Inches(y2 + 0.32)
        )
        line.line.color.rgb = RGBColor(175, 188, 196)
        line.line.width = Pt(1.4)
    for left, top, label, color in nodes:
        shape = _rect(slide, left, top, 1.12, 0.64, color, WHITE, True)
        _set_text(shape, label, 14, WHITE, True, PP_ALIGN.CENTER)
    _text(
        slide,
        7.05,
        5.35,
        4.85,
        0.62,
        "统一实体与关系 → 固定跳数路径 → 可复核答案",
        13,
        MUTED,
        align=PP_ALIGN.CENTER,
    )
    _notes(
        slide,
        "大家好，我们是第24组。CampusEcho 处理角色只掌握局部线索时的搜索、推理与行动问题。冻结测试有160道题，五种策略共800条记录。",
    )


def _slide_space(prs):
    slide = _base(prs, SLIDE_TITLES[1], 2)
    _text(
        slide,
        0.72,
        1.38,
        3.75,
        1.05,
        "所有策略共享分层状态、固定跳数目标与同一合法路径口径",
        20,
        bold=True,
    )
    _text(
        slide,
        0.72,
        2.72,
        3.65,
        2.0,
        "状态保存实体、深度与当前路径。候选扩展读取公开关系；答案按终点集合比较，路径按固定跳数的完整简单路径比较",
        14.2,
        MUTED,
    )
    _label(slide, 0.72, 5.15, 3.15, "同一输入与预算", TEAL, WHITE)
    for i, (number, label, color) in enumerate(
        (
            ("1", "起点实体", NAVY),
            ("2", "关系扩展", TEAL),
            ("3", "固定深度", SAGE),
            ("4", "终点与路径", RUST),
        )
    ):
        top = 1.38 + i * 1.18
        circle = slide.shapes.add_shape(
            MSO_AUTO_SHAPE_TYPE.OVAL, Inches(5.30), Inches(top), Inches(0.68), Inches(0.68)
        )
        circle.fill.solid()
        circle.fill.fore_color.rgb = color
        circle.line.color.rgb = color
        _set_text(circle, number, 15, WHITE, True, PP_ALIGN.CENTER)
        _text(slide, 6.25, top + 0.08, 2.5, 0.45, label, 17, bold=True)
        if i < 3:
            connector = slide.shapes.add_connector(
                1, Inches(5.64), Inches(top + 0.70), Inches(5.64), Inches(top + 1.16)
            )
            connector.line.color.rgb = LINE
            connector.line.width = Pt(2)
    _rect(slide, 9.18, 1.42, 3.05, 4.62, PAPER, LINE, True)
    _text(slide, 9.52, 1.76, 2.4, 0.48, "评测口径", 17, bold=True)
    _text(
        slide,
        9.52,
        2.40,
        2.35,
        3.15,
        "答案正确：终点集合相等\n\n路径有效：关系合同成立\n\n路径完整：全部固定跳数路径均被找回",
        14,
        MUTED,
    )
    _notes(
        slide,
        "统一搜索空间保证比较公平。答案与路径分别评分，这解释了为什么答案正确不等于路径完整。",
    )


def _slide_search(prs):
    slide = _base(prs, SLIDE_TITLES[2], 3)
    _text(slide, 0.72, 1.38, 5.25, 0.72, "三种策略在相同图谱上采用不同扩展顺序", 20, bold=True)
    for i, (name, description, color) in enumerate(
        (
            ("BFS", "按层穷举，基线完整但候选检查较多。", NAVY),
            ("A*", "使用手工或 GA 学习权重排序，减少无效扩展。", RUST),
            ("MCTS", "用模拟回报选择分支，扩展节点最少。", TEAL),
        )
    ):
        top = 2.45 + i * 1.18
        _rect(slide, 0.72, top, 0.10, 0.86, color)
        _text(slide, 1.02, top, 1.15, 0.42, name, 17, color, True)
        _text(slide, 2.22, top - 0.02, 3.6, 0.92, description, 14, MUTED)
    _image(slide, DEFAULT_FIGURES / "01_method_candidates.png", 6.05, 1.38, 6.48)
    _text(
        slide,
        6.25,
        6.15,
        6.0,
        0.48,
        "MCTS 的平均扩展节点最低；GA-A* 的候选检查低于 BFS 与手工 A*。",
        12.5,
        MUTED,
        align=PP_ALIGN.CENTER,
    )
    _notes(
        slide,
        "BFS 按层扩展，A* 用启发权重排序，MCTS 用模拟回报选择分支。冻结测试中，MCTS 的平均扩展节点最低。",
    )


def _slide_results(prs, frozen):
    slide = _base(prs, SLIDE_TITLES[3], 4)
    rows = frozen.test_rows
    ga = rows["ga_astar"]
    classifier = rows["ga_astar_classifier"]
    _text(slide, 0.72, 1.35, 4.2, 0.90, "测试前冻结参数\n结果与代价一并保留", 20, bold=True)
    _metric(slide, 0.72, 2.50, f"{float(ga['mean_candidate_checks']):.2f}", "GA-A* 平均候选检查")
    _metric(
        slide, 2.65, 2.50, f"{float(classifier['mean_expanded_nodes']):.2f}", "加分类器平均扩展节点"
    )
    _label(
        slide,
        0.72,
        4.02,
        2.75,
        f"验证集校准阈值 {float(frozen.parameters['classifier_threshold']):.2f}",
        SAGE,
        WHITE,
        11.5,
    )
    _text(
        slide,
        0.72,
        4.72,
        4.55,
        1.05,
        "分类器将平均扩展节点从 GA-A* 的 3.59 降至 3.20，候选检查从 5.21 增至 7.22。所有方法答案正确率均为 100%，路径完整率均为 13.125%。",
        13.2,
        MUTED,
    )
    _text(slide, 0.72, 5.95, 4.55, 0.52, "测试集仅用于最终评测，未参与拟合", 11.5, SAGE, bold=True)
    # 一页只保留一张主图，避免投影时图内标签被两栏压缩。
    _image(slide, DEFAULT_FIGURES / "03_ga_weights.png", 5.28, 1.32, 7.15)
    _text(
        slide,
        5.28,
        5.48,
        7.15,
        0.42,
        "验证集 2461 个样本，冻结阈值 0.80；冻结包未保存完整混淆矩阵",
        11.8,
        MUTED,
        align=PP_ALIGN.CENTER,
    )
    _text(
        slide,
        5.28,
        5.98,
        7.15,
        0.40,
        "扩展节点下降 10.9%，候选检查增加 38.5%",
        13.2,
        RUST,
        bold=True,
        align=PP_ALIGN.CENTER,
    )
    _notes(
        slide,
        "GA 与分类器都只用训练和验证数据，测试前冻结。加入分类器后扩展节点从3.59降到3.20，但候选检查升到7.22。阈值0.80来自验证集平衡准确率。",
    )


def _slide_llm(prs):
    slide = _base(prs, SLIDE_TITLES[4], 5)
    _text(
        slide,
        0.72,
        1.38,
        4.8,
        0.78,
        "LLM 只能提出建议，本地规则与验证器保留最终裁决。",
        20,
        bold=True,
    )
    for i, (label, text, color) in enumerate(
        (
            ("允许", "查询词建议、候选动作意见、已验证路径解释", TEAL),
            ("拒绝", "私有标签、世界真值、非法动作与自由改写路径", RUST),
            ("降级", "坏 JSON、越界参数、超时或空响应回退本地结果", NAVY),
        )
    ):
        top = 2.55 + i * 1.15
        _label(slide, 0.72, top, 0.92, label, color, WHITE)
        _text(slide, 1.86, top + 0.02, 4.15, 0.82, text, 13.5, MUTED)
    _rect(slide, 6.42, 1.42, 5.88, 4.68, PAPER, LINE, True)
    _text(slide, 6.78, 1.78, 5.05, 0.44, "本地验证链", 17, bold=True)
    for i, text in enumerate(("模型建议", "JSON 白名单", "动作合法性", "路径执行", "确定性结果")):
        top = 2.50 + i * 0.66
        _text(slide, 6.88, top, 1.55, 0.36, text, 13, NAVY, True)
        if i < 4:
            _text(slide, 8.48, top, 0.40, 0.36, "↓", 14, MUTED)
    _text(
        slide,
        8.95,
        2.46,
        2.95,
        2.90,
        "官方 DeepSeek 已完成真实评分与解释验证。\n\n"
        "正式冻结实验未混入 LLM 评分，稳定收益仍需正式对照。",
        13.2,
        MUTED,
    )
    _notes(
        slide,
        "LLM 只承担建议角色。输出先经过 JSON 白名单，再检查动作是否合法。"
        "官方 DeepSeek 已完成真实评分与解释验证。正式冻结实验没有把 LLM 评分混入算法对照，"
        "因此稳定收益仍需通过正式对照确认。",
    )


def _slide_closure(prs):
    slide = _base(prs, SLIDE_TITLES[5], 6)
    _text(
        slide,
        0.72,
        1.38,
        5.2,
        0.72,
        "角色在局部信息下搜索、判断、求证、行动，再由世界结果回写。",
        20,
        bold=True,
    )
    for i, (name, caption) in enumerate(
        (
            ("观察", "角色视图"),
            ("搜索", "答案与路径"),
            ("选择", "合法动作"),
            ("执行", "世界推进"),
            ("回写", "新线索"),
        )
    ):
        left = 0.72 + i * 1.12
        shape = _rect(slide, left, 2.65, 0.92, 0.92, NAVY if i % 2 == 0 else TEAL, radius=True)
        _set_text(shape, name, 14, WHITE, True, PP_ALIGN.CENTER)
        _text(slide, left - 0.02, 3.75, 0.96, 0.48, caption, 10.5, MUTED, align=PP_ALIGN.CENTER)
        if i < 4:
            _text(slide, left + 0.95, 2.88, 0.18, 0.32, "›", 22, MUTED)
    _text(
        slide,
        0.72,
        4.72,
        5.45,
        0.72,
        "任务成功由本地状态机结算；LLM 建议不能绕过同地、截止时间与动作前置条件。",
        13.2,
        MUTED,
    )
    _rect(slide, 6.62, 1.40, 5.62, 4.92, PAPER, LINE, True)
    _text(slide, 6.96, 1.78, 4.95, 0.48, "项目成员", 17, bold=True)
    _text(slide, 6.96, 2.48, 4.95, 0.92, "  ·  ".join(MEMBERS), 15, NAVY, True, PP_ALIGN.CENTER)
    _text(
        slide,
        6.96,
        3.55,
        4.95,
        1.45,
        "成员按平等顺序列名。\n\n主结果来自受控虚拟校园实验。\n"
        "官方 DeepSeek 已完成真实评分与解释验证。\n"
        "正式冻结实验未混入 LLM，稳定收益仍需正式对照。",
        13.2,
        MUTED,
        align=PP_ALIGN.CENTER,
    )
    _label(slide, 7.55, 5.18, 3.75, "谢谢聆听", RUST, WHITE, 14)
    _notes(
        slide,
        "观察、搜索、选择、执行和回写组成校园任务闭环。成员为徐阳、廖信同、黎欣欣、周艳雯、殷浚峰，按平等顺序列名。谢谢大家。",
    )


def render_presentation(path, output_dir):
    """Render every slide through PowerPoint COM and return page images."""

    path = Path(path).resolve()
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    for old in output_dir.glob("*.PNG"):
        old.unlink()
    script = r"""param([string]$InputFile,[string]$OutputDir)
$ErrorActionPreference='Stop'
$app=$null
$presentation=$null
try {
 $app=New-Object -ComObject PowerPoint.Application
 $presentation=$app.Presentations.Open($InputFile,$true,$false,$false)
 $presentation.Export($OutputDir,'PNG',1600,900)
 Write-Output ('SLIDES=' + $presentation.Slides.Count)
} finally {
 if($null -ne $presentation){$presentation.Close()}
 if($null -ne $app){$app.Quit()}
}
"""
    with tempfile.TemporaryDirectory(prefix="campusecho_ppt3_") as temp:
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
                str(path),
                "-OutputDir",
                str(output_dir),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
    (output_dir / "powerpoint_export.log").write_text(
        process.stdout + process.stderr, encoding="utf-8"
    )
    if process.returncode != 0:
        raise RuntimeError("PowerPoint 渲染失败，请检查 powerpoint_export.log")
    images = sorted(
        output_dir.glob("*.PNG"),
        key=lambda item: (
            int(re.search(r"(\d+)", item.stem).group(1)) if re.search(r"(\d+)", item.stem) else 0
        ),
    )
    if len(images) != 6:
        raise RuntimeError(f"PowerPoint 应渲染 6 页，实际 {len(images)} 页")
    for image in images:
        with Image.open(image) as opened:
            if opened.size != (1600, 900):
                raise RuntimeError(f"PPT 渲染尺寸错误: {image.name} {opened.size}")
    return images


def inspect_presentation(path):
    prs = Presentation(path)
    if len(prs.slides) != 6:
        raise RuntimeError(f"PPT 应为 6 页，实际 {len(prs.slides)} 页")
    if round(prs.slide_width / 914400, 4) != 13.3333 or round(prs.slide_height / 914400, 4) != 7.5:
        raise RuntimeError("PPT 页面不是 16:9")
    text = "\n".join(
        shape.text for slide in prs.slides for shape in slide.shapes if hasattr(shape, "text")
    )
    required = (
        "CampusEcho",
        GROUP,
        REPORT_DATE,
        *MEMBERS,
        "官方 DeepSeek 已完成真实评分与解释验证",
        "正式冻结实验未混入 LLM",
        "稳定收益仍需正式对照",
        "GA-A*",
        "分类器",
    )
    missing = [v for v in required if v not in text]
    if missing:
        raise RuntimeError(f"PPT 缺少必要文本: {missing}")
    forbidden = (
        "报告三",
        "报告编号",
        "套壳",
        "第91组",
        "LLM 评分为 0 条",
        "实网调用与收益仍待验证",
        "实网 LLM 收益尚未验证",
    )
    found = [v for v in forbidden if v in text]
    if found:
        raise RuntimeError(f"PPT 出现禁止文本: {found}")
    return {
        "slides": len(prs.slides),
        "width_inches": round(prs.slide_width / 914400, 4),
        "height_inches": round(prs.slide_height / 914400, 4),
        "text_characters": len(text),
        "required_text": list(required),
        "forbidden_text_absent": list(forbidden),
    }


def build_presentation(output=DEFAULT_OUTPUT, frozen_root=DEFAULT_FROZEN):
    frozen = load_frozen(frozen_root)
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if not all(
        (DEFAULT_FIGURES / name).is_file()
        for name in (
            "01_method_candidates.png",
            "03_ga_weights.png",
            "05_classifier_calibration.png",
        )
    ):
        build_assets(frozen_root, DEFAULT_FIGURES)
    prs = Presentation()
    prs.slide_width = Inches(13.333333)
    prs.slide_height = Inches(7.5)
    _slide_problem(prs, frozen)
    _slide_space(prs)
    _slide_search(prs)
    _slide_results(prs, frozen)
    _slide_llm(prs)
    _slide_closure(prs)
    prs.core_properties.title = "CampusEcho 校园回响"
    prs.core_properties.subject = "两分钟课堂汇报"
    prs.core_properties.author = GROUP
    prs.core_properties.keywords = "知识图谱 搜索 GA 分类器 LLM 校园互动"
    prs.save(output)
    notes = [
        {
            "slide": index,
            "notes": slide.notes_slide.notes_text_frame.text,
        }
        for index, slide in enumerate(prs.slides, 1)
    ]
    (output.parent / "ppt_notes.json").write_text(
        json.dumps(notes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    receipt = {
        "schema_version": 1,
        "built_at": datetime.now(UTC).isoformat(),
        "status": "complete",
        "pptx": str(output),
        "group": GROUP,
        "date": REPORT_DATE,
        "members": list(MEMBERS),
        "frozen_root": str(frozen.root),
        "inspection": inspect_presentation(output),
        "render": {
            "status": "complete",
            "backend": "Microsoft PowerPoint COM",
            "pngs": [
                {"path": str(p), "bytes": p.stat().st_size}
                for p in render_presentation(output, output.parent / "ppt-render")
            ],
        },
        "claim_boundaries": [
            "官方 DeepSeek 已完成真实评分与解释验证。",
            "正式冻结实验未混入 LLM 评分，稳定收益仍需正式对照。",
            "PPT 不包含报告编号或套壳。",
        ],
    }
    output.with_suffix(".build.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--frozen-root", type=Path, default=DEFAULT_FROZEN)
    args = parser.parse_args(argv)
    receipt = build_presentation(args.output, args.frozen_root)
    print(
        json.dumps(
            {
                "status": receipt["status"],
                "pptx": receipt["pptx"],
                "slides": receipt["inspection"]["slides"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
