"""Word 原生导出 PDF，并复用 documents 技能 canonical rasterize。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

SKILL = Path('D:/DotConfig/.codex/plugins/cache/openai-primary-runtime/documents/26.1026.10807/skills/documents')
DEPENDENCIES = Path('C:/Users/徐阳/.cache/codex-runtimes/codex-primary-runtime/dependencies')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def word_pdf(input_path: str, output_path: str, log_path: Path):
    # 独立创建并关闭隐藏 Word 实例；不接管用户已有的 Word 窗口。
    ps = r'''param([string]$InputFile,[string]$OutputFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $doc = $word.Documents.Open($InputFile, $false, $true, $false)
    $doc.Fields.Update() | Out-Null
    $doc.Repaginate()
    $pages = $doc.ComputeStatistics(2)
    $doc.ExportAsFixedFormat($OutputFile, 17)
    Write-Output ('WORD_PAGES=' + $pages)
    Write-Output ('WORD_VERSION=' + $word.Version)
} finally {
    if ($null -ne $doc) { $doc.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
    if ($null -ne $word) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
'''
    with tempfile.TemporaryDirectory(prefix='campusecho_word_') as temp:
        script = Path(temp) / 'export.ps1'
        script.write_text(ps, encoding='utf-8-sig')
        proc = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                               '-File', str(script), '-InputFile', input_path, '-OutputFile', output_path],
                              check=False, capture_output=True, text=True, encoding='utf-8', timeout=120,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    log = proc.stdout + proc.stderr
    if log_path.exists():
        previous = log_path.with_name('word_export.previous_' + datetime.now(UTC).strftime('%Y%m%dT%H%M%S') + '.log')
        shutil.copy2(log_path, previous)
    log_path.write_text(log, encoding='utf-8')
    if proc.returncode or not Path(output_path).is_file():
        raise RuntimeError('Word导出失败：' + log)
    return log


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('--output-dir', type=Path, required=True)
    p.add_argument('--pdf-output', type=Path)
    p.add_argument('--dpi', type=int, default=160)
    args = p.parse_args()
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    source = args.input.resolve()
    original_hash = sha(source)
    spec = importlib.util.spec_from_file_location('canonical_docx_renderer', SKILL / 'render_docx.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    try:
        resolved = renderer._resolve_soffice()
        reason = 'Windows bundle does not provide LibreOffice. User desktop LibreOffice is excluded. Resolver result: ' + resolved
    except FileNotFoundError as exc:
        reason = str(exc)
    logs = []

    def convert_to_pdf(doc_path, user_profile, convert_tmp_dir, stem, verbose):
        target = str(Path(convert_tmp_dir) / (stem + '.pdf'))
        log = word_pdf(doc_path, target, out / 'word_export.log')
        logs.append(log)
        return target, log

    renderer.convert_to_pdf = convert_to_pdf
    # 只替换 PDF 转换后端，PNG 路径和分页仍来自技能的 canonical rasterize。
    poppler = DEPENDENCIES / 'native/poppler/Library/bin'
    os.environ['PATH'] = str(poppler) + os.pathsep + os.environ.get('PATH', '')
    pages = renderer.rasterize(str(source), str(out), args.dpi, verbose=True, emit_pdf=True)
    pdf = out / (source.stem + '.pdf')
    if args.pdf_output:
        destination = args.pdf_output.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pdf, destination)
    else:
        destination = pdf
    if sha(source) != original_hash:
        raise RuntimeError('导出期间DOCX发生变化')
    from pypdf import PdfReader
    reader = PdfReader(destination)
    pdf_text = re.sub(r'\s+', '', ''.join(page.extract_text() for page in reader.pages))
    receipt = {'rendered_at': datetime.now(UTC).isoformat(),
               'docx': str(source), 'docx_sha256': original_hash,
               'pdf': str(destination), 'pdf_sha256': sha(destination),
               'pages': len(reader.pages), 'dpi': args.dpi,
               'content_anchors': {s: s in pdf_text for s in ('87%', '52%', '118350', '58.08%', '12.51%', '26至46', '20361106')},
               'pngs': [{'path': str(Path(x).resolve()), 'sha256': sha(x)} for x in pages],
               'pdf_backend': 'Microsoft Word COM ExportAsFixedFormat 17',
               'rasterizer': str(SKILL / 'render_docx.py'),
               'backend_reason': reason, 'word_logs': logs, 'visual_review': 'pending'}
    (out / 'render_receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
