"""由冻结 Markdown 重建可编辑公式的正式报告；请使用 Codex bundled Python。"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
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

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'artifacts/documents'
PANDOC = Path('D:/Anaconda3/Library/bin/pandoc.exe')
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def font(spec, name='宋体', size=11.5, bold=False):
    spec.font.name = 'Times New Roman' if name == '宋体' else name
    spec.font.size = Pt(size)
    spec.font.bold = bold
    spec.font.italic = False
    spec.font.color.rgb = RGBColor(0, 0, 0)
    rp = spec.element.get_or_add_rPr() if hasattr(spec, 'element') else spec._element.get_or_add_rPr()
    rf = rp.find(qn('w:rFonts'))
    if rf is None:
        rf = OxmlElement('w:rFonts')
        rp.insert(0, rf)
    for attr, value in [('eastAsia', name), ('ascii', spec.font.name), ('hAnsi', spec.font.name)]:
        rf.set(qn('w:' + attr), value)
    for attr in ('asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme'):
        rf.attrib.pop(qn('w:' + attr), None)


def set_style(doc, name, face, size, *, bold=False, before=0, after=0):
    s = doc.styles[name]
    font(s, face, size, bold)
    s.paragraph_format.space_before = Pt(before)
    s.paragraph_format.space_after = Pt(after)
    s.paragraph_format.line_spacing = 1.30
    # 标题不保留模板中可能出现的主题色与装饰边框。
    if s.element.pPr is not None:
        for node in list(s.element.pPr):
            if node.tag in (qn('w:pBdr'), qn('w:shd')):
                s.element.pPr.remove(node)
    return s


def caption_before_table(table, label):
    p = OxmlElement('w:p')
    table._tbl.addprevious(p)
    from docx.text.paragraph import Paragraph
    pp = Paragraph(p, table._parent)
    pp.style = 'Caption'
    pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    pp.paragraph_format.keep_with_next = True
    pp.add_run(label)


def format_docx(path: Path):
    doc = Document(path)
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(.85)
    section.left_margin = section.right_margin = Inches(.9)
    section.header_distance = section.footer_distance = Inches(.35)
    set_style(doc, 'Normal', '宋体', 11.5, after=3)
    set_style(doc, 'Body Text', '宋体', 11.5, after=3)
    set_style(doc, 'Title', '黑体', 20, bold=False, after=8)
    set_style(doc, 'Heading 1', '黑体', 15, before=12, after=6)
    set_style(doc, 'Heading 2', '黑体', 12.5, before=9, after=5)
    set_style(doc, 'Heading 3', '黑体', 11.5, before=7, after=4)
    set_style(doc, 'Caption', '宋体', 10.5, before=4, after=7)
    if 'Image Caption' in doc.styles:
        set_style(doc, 'Image Caption', '宋体', 10.5, before=4, after=7)
    for name in ('Hyperlink', 'FollowedHyperlink'):
        if name in doc.styles:
            doc.styles[name].font.color.rgb = RGBColor(0, 0, 0)

    # Pandoc 的首个一级标题转为 Word Title；后续层级对应论文的章节。
    first = True
    for p in doc.paragraphs:
        if first and p.text.strip():
            p.style = 'Title'
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            first = False
        elif p.style.name == 'Heading 2':
            p.style = 'Heading 1'
        elif p.style.name == 'Heading 3':
            p.style = 'Heading 2'
        if p.style.name.startswith('Heading'):
            p.paragraph_format.keep_with_next = True
            p.paragraph_format.keep_together = True
            p.paragraph_format.page_break_before = False
            p.paragraph_format.first_line_indent = Pt(0)
        elif p.style.name in ('Normal', 'Body Text', 'First Paragraph'):
            p.paragraph_format.first_line_indent = Pt(23)
        if p.text.strip() == '第91组':
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.space_after = Pt(10)
        if p.text.startswith('关键词'):
            p.paragraph_format.first_line_indent = Pt(0)
        if re.match(r'^\[\d+\]', p.text):
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.left_indent = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            p.paragraph_format.space_after = Pt(5)
            for run in p.runs:
                font(run, '宋体', 10)
        if p._p.xpath('.//m:oMathPara'):
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.space_before = Pt(5)
            p.paragraph_format.space_after = Pt(7)
            p.paragraph_format.keep_together = True
        if p._p.xpath('.//w:drawing'):
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.keep_with_next = True
            p.paragraph_format.space_after = Pt(0)
        if p.style.name in ('Caption', 'Image Caption'):
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.first_line_indent = Pt(0)
            p.paragraph_format.keep_with_next = False
            p.paragraph_format.keep_together = True
        p.paragraph_format.widow_control = True
        if p._p.pPr is not None:
            for border in p._p.pPr.findall(qn('w:pBdr')):
                p._p.pPr.remove(border)
        for run in p.runs:
            # 清除 Pandoc 的直接主题颜色；数学 OMML 不经过普通 run 重写。
            run.font.color.rgb = RGBColor(0, 0, 0)
            rp = run._element.rPr
            if rp is not None:
                for c in rp.findall(qn('w:color')):
                    c.attrib.pop(qn('w:themeColor'), None)
    for shape in doc.inline_shapes:
        ratio = shape.height / shape.width
        shape.width = Inches(6.65)
        shape.height = int(shape.width * ratio)
        dp = shape._inline.docPr
        if not dp.get('descr'):
            dp.set('descr', 'CampusEcho受控实验结果研究图')

    for idx, table in enumerate(doc.tables, 1):
        labels = {1: '表1 正式静态测试方法比较', 2: '表2 五种策略的动态任务结果'}
        caption_before_table(table, labels.get(idx, f'表{idx} 实验结果'))
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False
        widths = ([2.1, 1.25, 1.05, 1.05, 1.25] if len(table.columns) == 5
                  else [1.25, 1.72, .83, 1.00, .87, 1.03])
        if len(widths) != len(table.columns):
            widths = [6.7 / len(table.columns)] * len(table.columns)
        for col, width in zip(table.columns, widths):
            col.width = Inches(width)
        for r_idx, row in enumerate(table.rows):
            trpr = row._tr.get_or_add_trPr()
            no_split = OxmlElement('w:cantSplit')
            trpr.append(no_split)
            if r_idx == 0:
                trpr.append(OxmlElement('w:tblHeader'))
            for c_idx, cell in enumerate(row.cells):
                cell.width = Inches(widths[c_idx])
                cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
                pr = cell._tc.get_or_add_tcPr()
                borders = OxmlElement('w:tcBorders')
                for edge in ('top', 'left', 'bottom', 'right'):
                    el = OxmlElement('w:' + edge)
                    for k, v in [('val', 'single'), ('sz', '4'), ('color', 'D9D9D9')]:
                        el.set(qn('w:' + k), v)
                    borders.append(el)
                pr.append(borders)
                shade = OxmlElement('w:shd')
                shade.set(qn('w:fill'), 'E4E4E4' if r_idx == 0 else 'FFFFFF')
                pr.append(shade)
                margins = OxmlElement('w:tcMar')
                for edge in ('top', 'bottom', 'left', 'right'):
                    el = OxmlElement('w:' + edge)
                    el.set(qn('w:w'), '80')
                    el.set(qn('w:type'), 'dxa')
                    margins.append(el)
                pr.append(margins)
                for p in cell.paragraphs:
                    p.paragraph_format.first_line_indent = Pt(0)
                    p.paragraph_format.line_spacing = 1.15
                    p.paragraph_format.space_after = Pt(0)
                    p.paragraph_format.keep_with_next = False
                    p.alignment = WD_ALIGN_PARAGRAPH.LEFT if c_idx == 0 else WD_ALIGN_PARAGRAPH.CENTER
                    for run in p.runs:
                        font(run, '宋体', 10, r_idx == 0)
        following = table._tbl.getnext()
        if following is not None and following.tag == qn('w:p'):
            from docx.text.paragraph import Paragraph
            Paragraph(following, table._parent).paragraph_format.space_before = Pt(7)
    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), 'PAGE')
    footer._p.append(fld)
    doc.core_properties.title = doc.paragraphs[0].text
    doc.core_properties.author = '第91组'
    doc.core_properties.subject = 'CampusEcho课堂报告二'
    doc.core_properties.keywords = '混合推理 贝叶斯网络 D-S证据理论 校园互动'
    doc.save(path)


def inspect_docx(path: Path):
    with ZipFile(path) as z:
        root = etree.fromstring(z.read('word/document.xml'))
        text = ''.join(root.xpath('//w:t/text()', namespaces=NS))
        math = ''.join(root.xpath('//m:t/text()', namespaces=NS))
        return {'chinese_characters': len(re.findall(r'[\u4e00-\u9fff]', text)),
                'all_text_characters': len(text), 'math_characters': len(math),
                'native_math_objects': len(root.xpath('//m:oMath', namespaces=NS)),
                'display_equations': len(root.xpath('//m:oMathPara', namespaces=NS)),
                'images': len(root.xpath('//w:drawing', namespaces=NS)),
                'tables': len(root.xpath('//w:tbl', namespaces=NS)),
                'raw_latex_markers': re.findall(r'\\(?:frac|sum|theta|land|tag)\b', text),
                'figure_captions': root.xpath('//w:p[w:pPr/w:pStyle[@w:val="ImageCaption" or @w:val="Caption"]]//w:t/text()', namespaces=NS)}


def source_semantics(path: Path):
    """保留正文和原生公式次序；排版不得改变Pandoc已经转换的内容。"""
    with ZipFile(path) as z:
        root = etree.fromstring(z.read('word/document.xml'))
        return root.xpath('//w:t/text() | //m:t/text()', namespaces=NS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'docs/report.md')
    parser.add_argument('--source-sha256', help='终稿须指定内容冻结时的SHA-256')
    parser.add_argument('--final', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    source_hash = digest(source)
    if args.final and not args.source_sha256:
        parser.error('--final 需要 --source-sha256，防止作者正在写入时生成终稿')
    if args.source_sha256 and source_hash != args.source_sha256.lower():
        raise RuntimeError('源报告已变化，当前哈希不符合冻结哈希')
    out = (args.output or (ROOT.parent / '课程交付材料/CampusEcho_课堂报告二.docx' if args.final
                           else ART / 'draft/CampusEcho_课堂报告二.docx')).resolve()
    run_dir = ART / ('final' if args.final else 'draft')
    run_dir.mkdir(parents=True, exist_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    original_md = source.read_text(encoding='utf-8')
    snapshot = run_dir / 'report.snapshot.md'
    snapshot.write_bytes(source.read_bytes())
    md = original_md
    # Pandoc 的 TeXMath 将公式编译为 OMML；显式编号保留为公式内原生文本。
    md = re.sub(r'\\tag\{(\d+)\}', r'\\qquad \\mathrm{(\1)}', md)
    pandoc_input = run_dir / 'pandoc-input.md'
    pandoc_input.write_text(md, encoding='utf-8')
    images = [(source.parent / p).resolve() for p in re.findall(r'!\[[^\]]*\]\(([^)]+)\)', md)]
    for image in images:
        if not image.is_file():
            raise FileNotFoundError(image)
    figure_hashes = {str(p.relative_to(ROOT)): digest(p) for p in images}
    command = [str(PANDOC), str(pandoc_input), '--from=markdown+tex_math_single_backslash+tex_math_dollars',
               '--to=docx', '--standalone', '--resource-path=' + str(source.parent),
               '--output=' + str(out)]
    proc = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', check=True)
    (run_dir / 'pandoc.log').write_text(proc.stdout + proc.stderr, encoding='utf-8')
    if 'Could not convert' in proc.stderr:
        raise RuntimeError('Pandoc公式转换警告，检查pandoc.log')
    converted_semantics = source_semantics(out)
    format_docx(out)
    formatted_semantics = source_semantics(out)
    # 新增表题是唯一内容增量，其余文字和数学节点应按顺序完整保留。
    for caption in ('表1 正式静态测试方法比较', '表2 五种策略的动态任务结果'):
        if caption in formatted_semantics:
            formatted_semantics.remove(caption)
    if converted_semantics != formatted_semantics:
        raise RuntimeError('排版前后正文或公式文本发生变化')
    stats = inspect_docx(out)
    if stats['raw_latex_markers'] or stats['display_equations'] < 6:
        raise RuntimeError('原生公式结构校验失败')
    if args.final and not (5000 <= stats['chinese_characters'] <= 8000 and 4 <= stats['images'] <= 6):
        raise RuntimeError('终稿汉字数或研究图数量不符合交付要求')
    if digest(source) != source_hash or any(digest(p) != figure_hashes[str(p.relative_to(ROOT))] for p in images):
        raise RuntimeError('构建过程中源报告或图片变化，请冻结后重新构建')
    receipt = {'built_at': datetime.now(UTC).isoformat(), 'source': str(source),
               'source_sha256': source_hash, 'docx': str(out), 'docx_sha256': digest(out),
               'source_snapshot': str(snapshot), 'source_snapshot_sha256': digest(snapshot),
               'figures': figure_hashes, 'pandoc_command': command,
               'math_backend': 'Pandoc TeXMath native OMML', 'statistics': stats,
               'formatting_preserved_source_semantics': True,
               'final': args.final}
    (run_dir / 'build_receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
