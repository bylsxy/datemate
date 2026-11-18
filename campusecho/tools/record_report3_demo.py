"""Record a real one-minute browser demo of the CampusEcho research workflow."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "artifacts" / "report3"
OUT = REPORT / "demo"
FFMPEG = Path("C:/Users/徐阳/scoop/shims/ffmpeg.exe")
FFPROBE = FFMPEG.with_name("ffprobe.exe")
CHROME = Path("C:/Program Files/Google/Chrome/Application/chrome.exe")
MIN_RECEIPT_HOLD_SECONDS = 1.5
NARRATION_TAIL_MARGIN_SECONDS = 0.5
DURATION_TOLERANCE_SECONDS = 0.05
NARRATION = (
    "打开CampusEcho，知识图谱包含504个实体和1234条三元组。选择一个自然语言多跳问题，"
    "运行A星搜索，查看逐步轨迹和每一跳来源。"
    "切换MCTS、GA与分类器策略，比较扩展节点和候选检查。最后把有效路径带入校园任务，"
    "采纳后生成回执，世界状态随证明更新。"
)


def run(args: list[str], *, timeout: int = 180) -> None:
    result = subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])


def synth(output: Path) -> float:
    escaped = NARRATION.replace("'", "''")
    script = f"""$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {{
  $s.SelectVoice('Microsoft Huihui Desktop')
  $s.Rate=8
  $s.Volume=100
  $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile('{str(output).replace("'", "''")}',$format)
  $s.Speak('{escaped}')
  $s.SetOutputToNull()
}} finally {{ $s.Dispose() }}
"""
    with tempfile.TemporaryDirectory(prefix="campusecho_demo_tts_") as temp:
        path = Path(temp) / "tts.ps1"
        path.write_text(script, encoding="utf-8-sig")
        run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(path),
            ]
        )
    with wave.open(str(output), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def probe_media(path: Path) -> dict[str, object]:
    result = subprocess.run(
        [
            str(FFPROBE),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,duration",
            "-of",
            "json",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict):
        raise TypeError(f"ffprobe 返回了无效数据：{path}")
    return payload


def media_duration(media: dict[str, object]) -> float:
    format_info = media.get("format")
    if not isinstance(format_info, dict) or format_info.get("duration") is None:
        raise RuntimeError("媒体文件缺少总时长")
    return float(format_info["duration"])


def stream_duration(media: dict[str, object], codec_type: str) -> float:
    streams = media.get("streams")
    if not isinstance(streams, list):
        raise TypeError("媒体文件缺少流信息")
    for stream in streams:
        if not isinstance(stream, dict) or stream.get("codec_type") != codec_type:
            continue
        if stream.get("duration") is None:
            raise RuntimeError(f"{codec_type} 流缺少时长")
        return float(stream["duration"])
    raise RuntimeError(f"媒体文件缺少 {codec_type} 流")


def record(
    page: Page, *, recording_started: float, narration_seconds: float
) -> dict[str, object]:
    page.goto("http://127.0.0.1:8842/", wait_until="networkidle")
    page.locator("#run-search").click()
    page.wait_for_timeout(2500)
    page.locator("#trace-timeline").evaluate(
        "(node) => { node.value = node.max; node.dispatchEvent(new Event('input')); }"
    )
    page.wait_for_timeout(1000)
    page.locator('input[name="algorithm"][value="mcts"]').evaluate(
        "(node) => { node.checked = true; node.dispatchEvent(new Event('change', {bubbles:true})); }"
    )
    page.locator("#run-search").click()
    page.wait_for_timeout(2500)
    page.locator('input[name="algorithm"][value="ga_astar"]').evaluate(
        "(node) => { node.checked = true; node.dispatchEvent(new Event('change', {bubbles:true})); }"
    )
    page.locator("#run-search").click()
    page.wait_for_timeout(1500)
    page.locator('input[name="algorithm"][value="ga_classifier"]').evaluate(
        "(node) => { node.checked = true; node.dispatchEvent(new Event('change', {bubbles:true})); }"
    )
    page.locator("#run-search").click()
    page.wait_for_timeout(1500)
    page.locator("#trace-timeline").evaluate(
        "(node) => { node.value = node.max; node.dispatchEvent(new Event('input')); }"
    )
    page.wait_for_timeout(1000)
    page.locator("#send-to-sandbox").click()
    page.wait_for_timeout(1000)
    page.locator("#adopt-plan").click()
    page.wait_for_function(
        "() => document.querySelector('#receipt-state')?.textContent.trim() === '已写入'",
        timeout=5000,
    )
    receipt_visible_at = time.monotonic()
    target_end = max(
        receipt_visible_at + MIN_RECEIPT_HOLD_SECONDS,
        recording_started + narration_seconds + NARRATION_TAIL_MARGIN_SECONDS,
    )
    remaining_ms = max(0, round((target_end - time.monotonic()) * 1000))
    if remaining_ms:
        page.wait_for_timeout(remaining_ms)
    receipt_state = page.locator("#receipt-state").inner_text().strip()
    receipt_id = page.locator("#receipt-id").inner_text().strip()
    if receipt_state != "已写入" or receipt_id == "—":
        raise RuntimeError("录屏结束时未显示有效的校园采纳回执")
    return {
        "receipt_state": receipt_state,
        "receipt_id": receipt_id,
        "receipt_hold_seconds": round(time.monotonic() - receipt_visible_at, 3),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=REPORT / "CampusEcho_系统运行演示.mp4")
    args = parser.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    audio = OUT / "narration.wav"
    narration_seconds = synth(audio)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, executable_path=str(CHROME)
        )
        context = browser.new_context(
            viewport={"width": 1600, "height": 900},
            record_video_dir=str(OUT),
            record_video_size={"width": 1600, "height": 900},
        )
        page = context.new_page()
        recording_started = time.monotonic()
        record_metrics = record(
            page,
            recording_started=recording_started,
            narration_seconds=narration_seconds,
        )
        video = page.video
        raw = Path(video.path()) if video is not None else None
        context.close()
        browser.close()
    if raw is None:
        raise RuntimeError("Playwright 未生成录屏")
    raw_duration = media_duration(probe_media(raw))
    if raw_duration + DURATION_TOLERANCE_SECONDS < narration_seconds:
        raise RuntimeError(
            f"录屏 {raw_duration:.3f} 秒短于旁白 {narration_seconds:.4f} 秒"
        )
    target = args.output.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            str(FFMPEG),
            "-y",
            "-i",
            str(raw),
            "-i",
            str(audio),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-t",
            f"{raw_duration:.6f}",
            "-movflags",
            "+faststart",
            str(target),
        ],
        timeout=300,
    )
    final_media = probe_media(target)
    duration = media_duration(final_media)
    video_duration = stream_duration(final_media, "video")
    audio_duration = stream_duration(final_media, "audio")
    if audio_duration + DURATION_TOLERANCE_SECONDS < narration_seconds:
        raise RuntimeError(
            f"最终音轨 {audio_duration:.3f} 秒短于旁白 {narration_seconds:.4f} 秒"
        )
    if video_duration + DURATION_TOLERANCE_SECONDS < narration_seconds:
        raise RuntimeError(
            f"最终视频流 {video_duration:.3f} 秒短于旁白 {narration_seconds:.4f} 秒"
        )
    if duration > 60:
        raise RuntimeError(f"系统演示 {duration:.2f} 秒，超过一分钟")
    receipt = {
        "status": "complete",
        "video": str(target),
        "duration_seconds": round(duration, 3),
        "narration_seconds": narration_seconds,
        "video_stream_seconds": round(video_duration, 3),
        "audio_stream_seconds": round(audio_duration, 3),
        "tail_seconds": round(duration - narration_seconds, 3),
        "receipt_state": record_metrics["receipt_state"],
        "receipt_id": record_metrics["receipt_id"],
        "receipt_hold_seconds": record_metrics["receipt_hold_seconds"],
        "viewport": [1600, 900],
        "browser": "Google Chrome 157 headless",
        "narration": NARRATION,
        "workflow": [
            "load graph and natural question",
            "run A*",
            "play complete trace",
            "run MCTS",
            "run method comparison",
            "send verified result to sandbox",
            "adopt and show receipt",
        ],
    }
    (REPORT / "demo_receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "complete", **receipt}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
