"""Render the two-minute slide video and the one-minute live demo."""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "artifacts" / "report3"
SLIDES = REPORT / "ppt-render"
FFMPEG = Path("C:/Users/徐阳/scoop/shims/ffmpeg.exe")
FFPROBE = FFMPEG.with_name("ffprobe.exe")


def run(args: list[str], *, timeout: int = 180) -> subprocess.CompletedProcess[str]:
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
    return result


def synthesize(text: str, output: Path, rate: int = 3) -> None:
    escaped = text.replace("'", "''")
    script = f"""$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {{
  $s.SelectVoice('Microsoft Huihui Desktop')
  $s.Rate={rate}
  $s.Volume=100
  $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile('{str(output).replace("'", "''")}',$format)
  $s.Speak('{escaped}')
  $s.SetOutputToNull()
}} finally {{ $s.Dispose() }}
"""
    with tempfile.TemporaryDirectory(prefix="campusecho_tts3_") as temp:
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


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def video_duration(path: Path) -> float:
    result = run(
        [
            str(FFPROBE),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    return float(result.stdout.strip())


def build_slide_video(output: Path) -> dict[str, object]:
    notes = json.loads((REPORT / "ppt_notes.json").read_text(encoding="utf-8"))
    images = sorted(
        SLIDES.glob("*.PNG"),
        key=lambda path: int("".join(char for char in path.stem if char.isdigit())),
    )
    if len(notes) != 6 or len(images) != 6:
        raise RuntimeError("PPT 备注或渲染页数不是 6")
    audio_dir = REPORT / "video" / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    clips: list[Path] = []
    durations: list[float] = []
    for index, row in enumerate(notes, 1):
        audio = audio_dir / f"slide-{index:02d}.wav"
        synthesize(row["notes"], audio)
        seconds = wav_seconds(audio)
        durations.append(seconds)
        clips.append(audio)
    speech_total = sum(durations)
    if speech_total >= 116:
        raise RuntimeError(f"两分钟汇报音频为 {speech_total:.2f} 秒，没有片头片尾余量")
    # 保留可辨识的片头与结束停顿，使总时长稳定落在两分钟。
    lead = 3.0
    tail = 120.0 - lead - speech_total
    if tail < 2.0:
        raise RuntimeError("两分钟汇报音频过长，无法保留片尾停顿")
    concat = audio_dir / "audio.ffconcat"
    concat.write_text(
        "ffconcat version 1.0\n" + "".join(f"file '{clip.as_posix()}'\n" for clip in clips),
        encoding="utf-8",
    )
    speech = audio_dir / "speech.wav"
    run([str(FFMPEG), "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(speech)])
    narration = audio_dir / "narration.wav"
    run(
        [
            str(FFMPEG),
            "-y",
            "-f",
            "lavfi",
            "-t",
            f"{lead:.6f}",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-i",
            str(speech),
            "-f",
            "lavfi",
            "-t",
            f"{tail:.6f}",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-filter_complex",
            "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
            "-map",
            "[a]",
            "-c:a",
            "pcm_s16le",
            str(narration),
        ]
    )
    timeline: list[dict[str, object]] = []
    start = 0.0
    for index, (image, duration) in enumerate(zip(images, durations, strict=True), 1):
        slide_start = start
        slide_duration = duration + (lead if index == 1 else 0.0) + (tail if index == 6 else 0.0)
        timeline.append(
            {
                "slide": index,
                "image": str(image),
                "audio": str(clips[index - 1]),
                "start_seconds": round(slide_start, 3),
                "duration_seconds": round(slide_duration, 3),
                "narration": notes[index - 1]["notes"],
            }
        )
        start += slide_duration
    (REPORT / "video" / "timeline.json").write_text(
        json.dumps(timeline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    args = [str(FFMPEG), "-y"]
    visual_durations = [
        durations[0] + lead,
        *durations[1:-1],
        durations[-1] + tail,
    ]
    for image, duration in zip(images, visual_durations, strict=True):
        args.extend(["-loop", "1", "-t", f"{duration:.6f}", "-i", str(image)])
    args.extend(["-i", str(narration)])
    filters = []
    for index in range(6):
        filters.append(
            f"[{index}:v]scale=1600:900,format=yuv420p,setsar=1[v{index}]"
        )
    filters.append("".join(f"[v{index}]" for index in range(6)) + "concat=n=6:v=1:a=0[v]")
    args.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[v]",
            "-map",
            "6:a",
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
            "-movflags",
            "+faststart",
            "-shortest",
            str(output),
        ]
    )
    run(args, timeout=300)
    actual = video_duration(output)
    if not 118 <= actual <= 121:
        raise RuntimeError(f"汇报视频时长 {actual:.2f} 秒，不符合两分钟目标")
    return {
        "video": str(output),
        "duration_seconds": actual,
        "slides": 6,
        "voice": "Microsoft Huihui Desktop",
        "timeline": timeline,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output", type=Path, default=REPORT / "CampusEcho_两分钟汇报.mp4"
    )
    args = parser.parse_args(argv)
    receipt = build_slide_video(args.output.resolve())
    (REPORT / "video_receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "status": "complete",
                "video": receipt["video"],
                "duration_seconds": receipt["duration_seconds"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
