"""从最终PPT渲染图与逐页讲稿重建162秒中文汇报视频（仅标准库）。"""
import array
import hashlib
import json
import math
import shutil
import subprocess
import wave
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/video'
SRC = OUT / 'source'
FINAL = ROOT.parent / '课程交付材料/CampusEcho_三分钟汇报.mp4'
FFMPEG = Path('C:/Users/徐阳/scoop/shims/ffmpeg.EXE')
FFPROBE = FFMPEG.with_name('ffprobe.EXE')
COMMANDS = []


def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, log=None):
    args = [str(x) for x in args]
    COMMANDS.append(args)
    result = subprocess.run(
        args, check=False, capture_output=True, encoding='utf-8', errors='replace'
    )
    if log:
        log.write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'命令失败 {args}: {result.stderr[-3000:]}')
    return result.stdout


def wav_data(path):
    with wave.open(str(path), 'rb') as f:
        assert f.getsampwidth() == 2 and f.getnchannels() == 1
        return f.getframerate(), array.array('h', f.readframes(f.getnframes()))


def main():
    SRC.mkdir(parents=True, exist_ok=True)
    slides = ROOT / 'artifacts/slides'
    for name in ['video-scenes.json', 'narration.txt', 'delivery.json', 'qa-summary.json']:
        shutil.copy2(slides / name, SRC / name)
    spec = json.loads((SRC / 'video-scenes.json').read_text(encoding='utf-8'))
    delivery = json.loads((SRC / 'delivery.json').read_text(encoding='utf-8'))
    qa = json.loads((SRC / 'qa-summary.json').read_text(encoding='utf-8'))
    assert qa['status'] == 'passed'
    assert spec['total_seconds'] == sum(s['duration_seconds'] for s in spec['scenes']) == 162
    assert sha(Path(delivery['pptx'])) == qa['pptx_sha256']
    notes = {}
    with zipfile.ZipFile(delivery['pptx']) as z:
        for s in spec['scenes']:
            i = s['slide']
            xml = ET.fromstring(z.read(f'ppt/notesSlides/notesSlide{i}.xml'))
            paragraphs = [''.join(p.itertext()) for p in xml.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}p')]
            assert s['narration'] in paragraphs, f'第{i}页备注不匹配'
            notes[str(i)] = paragraphs
            assert s['narration'] in (SRC / 'narration.txt').read_text(encoding='utf-8')
    dump(SRC / 'ppt-notes.json', notes)
    ps = SRC / 'synthesize.ps1'
    ps.write_text('''param([string]$InputJson,[string]$OutputWav,[int]$Rate=0,[switch]$Enumerate)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
 if ($Enumerate) {
   $voices=@($s.GetInstalledVoices() | ForEach-Object { @{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name;enabled=$_.Enabled} })
   [IO.File]::WriteAllText($OutputWav,($voices | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
 } else {
   $j=[IO.File]::ReadAllText($InputJson,[Text.Encoding]::UTF8) | ConvertFrom-Json
   $s.SelectVoice('Microsoft Huihui Desktop')
   $s.Rate=$Rate
   $s.Volume=100
   $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
   $s.SetOutputToWaveFile($OutputWav,$format)
   $s.Speak([string]$j.spoken_text)
   $s.SetOutputToNull()
 }
} finally { $s.Dispose() }
''', encoding='utf-8-sig')
    base = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps]
    run(base + ['-Enumerate', '-OutputWav', OUT / 'voices.json'])
    voices = json.loads((OUT / 'voices.json').read_text(encoding='utf-8-sig'))
    assert any(v['name'] == 'Microsoft Huihui Desktop' and v['enabled'] for v in voices)
    timeline = []
    all_pcm = array.array('h')
    pos = 0
    for s in spec['scenes']:
        i, duration = s['slide'], s['duration_seconds']
        original = Path(delivery['final_import_png_dir']) / f'slide-{i:02}.png'
        image = SRC / f'slide-{i:02}.png'
        assert original.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
        import struct
        assert struct.unpack('>II', original.read_bytes()[16:24]) == (1920, 1080)
        assert sha(original) == sha(Path(s['file'])), '草稿图与PPT回读图不同'
        shutil.copy2(original, image)
        # 仅展开读音，原始讲稿逐字保存在时间线中；数值和语义不变。
        spoken = s['narration'].replace('1.26', '一点二六').replace('0.17', '零点一七').replace('D-S', '迪，艾斯').replace('Horn', '霍恩').replace('CampusEcho', 'Campus Echo')
        textfile = SRC / f'narration-{i:02}.json'
        dump(textfile, {'original_text': s['narration'], 'spoken_text': spoken})
        rate = 0
        while True:
            raw = OUT / f'slide-{i:02}-rate{rate}.wav'
            run(base + ['-InputJson', textfile, '-OutputWav', raw, '-Rate', rate])
            hz, pcm = wav_data(raw)
            seconds = len(pcm) / hz
            print(f'第{i}页 rate={rate}, 旁白{seconds:.2f}s / 场景{duration}s', flush=True)
            if seconds <= duration - .5:
                break
            rate += 1
            if rate > 4:
                raise RuntimeError('自然语速无法容纳讲稿，需人工调整，拒绝截断旁白')
        lead = int(.25 * hz)
        pad = duration * hz - lead - len(pcm)
        assert pad >= 0
        segment = array.array('h', [0]) * lead + pcm + array.array('h', [0]) * pad
        all_pcm.extend(segment)
        timeline.append({**s, 'start_seconds': pos, 'end_seconds': pos + duration,
                         'original_png': str(original), 'png_sha256': sha(original),
                         'archived_png': str(image), 'spoken_text': spoken, 'voice': 'Microsoft Huihui Desktop',
                         'tts_rate': rate, 'raw_wav': str(raw), 'speech_duration_seconds': seconds,
                         'leading_silence_seconds': .25, 'trailing_padding_seconds': pad / hz,
                         'raw_wav_sha256': sha(raw)})
        pos += duration
    # 统一峰值至-3dBFS，保留自然语速，不进行时间拉伸。
    peak = max(abs(v) for v in all_pcm)
    gain = (32767 * 10 ** (-3 / 20)) / peak
    normalized = array.array('h', (round(v * gain) for v in all_pcm))
    audio = OUT / 'narration-162s.wav'
    with wave.open(str(audio), 'wb') as f:
        f.setparams((1, 2, hz, 0, 'NONE', 'not compressed'))
        f.writeframes(normalized.tobytes())
    dump(OUT / 'timeline.json', timeline)
    concat = SRC / 'slides.ffconcat'
    concat.write_text('ffconcat version 1.0\n' + ''.join(f"file 'slide-{s['slide']:02}.png'\nduration {s['duration_seconds']}\n" for s in spec['scenes']) + "file 'slide-07.png'\n", encoding='utf-8')
    FINAL.parent.mkdir(parents=True, exist_ok=True)
    run([FFMPEG, '-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', concat,
         '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-t', '162', '-r', '25',
         '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '18',
         '-threads', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
         '-ar', '48000', '-movflags', '+faststart', FINAL], OUT / 'encode.log')
    probe = json.loads(run([FFPROBE, '-v', 'error', '-show_format', '-show_streams', '-of', 'json', FINAL]))
    dump(OUT / 'ffprobe.json', probe)
    video = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    aud = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
    assert video['codec_name'] == 'h264' and video['pix_fmt'] == 'yuv420p'
    assert (video['width'], video['height']) == (1920, 1080) and aud['codec_name'] == 'aac'
    assert abs(float(probe['format']['duration']) - 162) < .1
    for label, t in [('first', 1), ('middle', 81), ('last', 160)]:
        run([FFMPEG, '-y', '-hide_banner', '-ss', str(t), '-i', FINAL, '-frames:v', '1', OUT / f'check-{label}.png'], OUT / f'check-{label}.log')
    run([FFMPEG, '-hide_banner', '-i', FINAL, '-vn', '-af', 'silencedetect=noise=-40dB:d=0.5,astats=metadata=0:reset=0', '-f', 'null', '-'], OUT / 'audio-statistics.log')
    run([FFMPEG, '-hide_banner', '-v', 'error', '-i', FINAL, '-f', 'null', '-'], OUT / 'decode-check.log')
    stats = {'sample_rate': hz, 'duration_seconds': len(normalized) / hz,
             'peak_dbfs': 20 * math.log10(max(abs(v) for v in normalized) / 32768),
             'clipped_samples': sum(abs(v) >= 32767 for v in normalized),
             'rms_dbfs': 20 * math.log10(math.sqrt(sum(v*v for v in normalized) / len(normalized)) / 32768),
             'normalization_gain': gain}
    receipt = {'status': 'passed', 'final': str(FINAL), 'final_sha256': sha(FINAL),
               'pptx': delivery['pptx'], 'pptx_sha256': sha(Path(delivery['pptx'])),
               'render_build': delivery['build_dir'], 'source_inputs': {p.name: sha(p) for p in SRC.iterdir() if p.is_file()},
               'voice': 'Microsoft Huihui Desktop', 'tts': 'Windows System.Speech local synthesis',
               'audio': stats, 'timeline': timeline, 'ffprobe': probe, 'commands': COMMANDS,
               'references': ['https://learn.microsoft.com/en-us/dotnet/api/system.speech.synthesis.speechsynthesizer.setoutputtowavefile', 'https://ffmpeg.org/ffmpeg-filters.html'],
               'validation': {'full_decode': 'passed', 'first_middle_last_frames': 'exported_for_visual_review', 'notes_text_match_all_pages': True}}
    dump(OUT / 'receipt.json', receipt)
    shutil.copy2(Path(__file__), SRC / 'build_video.py')
    (OUT / '导出说明.md').write_text(f'CampusEcho 课堂报告二汇报视频时长162秒，共7页，画面来自已交付PPT的最终回读渲染图。中文旁白由本机 Microsoft Huihui Desktop 合成。逐页讲稿与PPT备注核对一致，读音展开记录在 timeline.json 中。\n\n视频采用1920×1080、25帧每秒、H.264/yuv420p与AAC。逐页时长为21、20、23、23、31、29、15秒；旁白使用自然合成语速，以页尾静音补齐时长。\n\nffprobe已验证时长与音视频参数，完整解码通过，PCM削波样本数为{stats["clipped_samples"]}。首、中、末帧与音频统计保存在同目录。\n\n重建命令：项目根目录下运行 `.repro-venv/Scripts/python.exe tools/build_video.py`。source目录保存输入、原PNG、PPT备注及合成脚本；receipt.json保存SHA-256、声线、时间线、命令与探测结果。\n', encoding='utf-8')
    print(json.dumps({'final': str(FINAL), 'duration': probe['format']['duration'], 'audio': stats}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
