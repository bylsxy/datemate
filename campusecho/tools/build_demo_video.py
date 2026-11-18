"""把Edge真实screencast帧按接收时间戳恢复为2倍慢放演示。"""
import array
import hashlib
import json
import math
import shutil
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/video/demo'
SRC = OUT / 'source'
RAW = ROOT / 'artifacts/qa/demo-recording'
FINAL = ROOT.parent / '课程交付材料/CampusEcho_系统运行演示.mp4'
FF = Path('C:/Users/徐阳/scoop/shims/ffmpeg.EXE')
COMMANDS = []


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def dump(p, value):
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def run(args, log=None):
    args = [str(a) for a in args]
    COMMANDS.append(args)
    r = subprocess.run(
        args,
        check=False,
        cwd=OUT,
        capture_output=True,
        encoding='utf-8',
        errors='replace',
    )
    if log:
        log.write_text(r.stdout + r.stderr, encoding='utf-8')
    if r.returncode:
        raise RuntimeError(r.stderr[-3000:])
    return r.stdout


def stamp(seconds):
    cs = round(seconds * 100)
    return f'{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}'


def main():
    SRC.mkdir(parents=True, exist_ok=True)
    shutil.copy2(RAW / 'recording.json', SRC / 'recording.json')
    data = json.loads((SRC / 'recording.json').read_text(encoding='utf-8'))
    frames, actions = data['frames'], data['actions']
    assert len(frames) == 74 and [a['tick'] for a in actions] == [20, 24, 28, 30, 32, 36, 43]
    origin = frames[0]['received']
    span = (frames[-1]['received'] - origin) / 1000
    assert abs(span - 15.512) < .001
    exact = 4 + 2 * span
    duration = math.ceil(exact * 25) / 25
    ffconcat = ['ffconcat version 1.0', f"file 'source/{frames[0]['file']}'", 'duration 2.000000']
    timeline = []
    for i, frame in enumerate(frames):
        original = RAW / frame['file']
        target = SRC / frame['file']
        shutil.copy2(original, target)
        digest = sha(original)
        assert digest == sha(target)
        dt = ((frames[i+1]['received'] - frame['received']) / 1000 * 2) if i + 1 < len(frames) else 2
        assert dt > 0
        ffconcat += [f"file 'source/{frame['file']}'", f'duration {dt:.6f}']
        timeline.append({**frame, 'sha256': digest, 'source_path': str(original),
                         'video_start_seconds': 2 + (frame['received'] - origin) / 1000 * 2,
                         'video_duration_seconds': dt})
    ffconcat.append(f"file 'source/{frames[-1]['file']}'")
    (OUT / 'frames.ffconcat').write_text('\n'.join(ffconcat) + '\n', encoding='utf-8')
    # 所有字幕均在原始1600×867界面外的上下留白中。
    header = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Top,Microsoft YaHei,28,&H003D4930,&H003D4930,&H00F2F7F6,&H00F2F7F6,0,0,0,0,100,100,0,0,1,0,0,8,20,20,12,1
Style: Bottom,Microsoft YaHei,32,&H003D4930,&H003D4930,&H00F2F7F6,&H00F2F7F6,0,0,0,0,100,100,0,0,1,0,0,2,20,20,24,1
[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
'''
    events = [f'Dialogue: 0,{stamp(0)},{stamp(duration)},Top,,0,0,0,,CampusEcho 系统运行演示 · Edge真实录屏 · 2×慢放（0.5×速度）']
    def caption(start, end, text):
        events.append(f'Dialogue: 0,{stamp(start)},{stamp(end)},Bottom,,0,0,0,,{text}')
    caption(0, 2, '校园任务：核对线索、传达改址、确认同行、截止前抵达\\N原始录屏按接收时间戳恢复，片头与片尾各停留2秒')
    narration = ['核对新旧线索，在截止前找到小汐。', '先前往有顶连廊。', '找到小汐，准备交谈。',
                 '当面传达活动改址。', '确认同行，一起出发。', '两人共同移动，前往新会场。',
                 '截止前抵达，任务完成，剩余十七分钟。']
    starts = [2 + max(0, a['wall'] - origin) / 1000 * 2 for a in actions]
    ends = starts[1:] + [duration]
    voice_segments = []
    audio = array.array('h', [0]) * round(duration * 24000)
    for i, (a, start, end, text) in enumerate(zip(actions, starts, ends, narration)):
        caption(start, end if i < 6 else 2 + span * 2, f"T+{a['tick']} · {a['label']}\\N真实操作界面；游戏时间按原录屏保留")
        if i == 6:
            caption(2 + span * 2, duration, '六次动作完成任务 · T+43，剩余17分钟\\N结尾保留真实行动记录与研究面板')
        # 首句可利用片头时间，其余旁白随关键状态开始，逐段防止串图。
        speak_start = .15 if i == 0 else start + .15
        textpath = SRC / f'demo-narration-{i:02}.json'
        dump(textpath, {'spoken_text': text})
        rate = 0
        while True:
            wav = OUT / f'narration-{i:02}-rate{rate}.wav'
            run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                 '-File', ROOT / 'artifacts/video/source/synthesize.ps1', '-InputJson', textpath,
                 '-OutputWav', wav, '-Rate', rate])
            with wave.open(str(wav), 'rb') as w:
                assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24000, 1, 2)
                pcm = array.array('h', w.readframes(w.getnframes()))
            seconds = len(pcm) / 24000
            if speak_start + seconds < end - .1:
                break
            rate += 1
            if rate > 2:
                raise RuntimeError('旁白无法在对应状态时间段内自然读完')
        offset = round(speak_start * 24000)
        audio[offset:offset + len(pcm)] = pcm
        voice_segments.append({'tick': a['tick'], 'text': text, 'start_seconds': speak_start,
                               'duration_seconds': seconds, 'rate': rate, 'wav': str(wav), 'sha256': sha(wav)})
        print(f'T+{a["tick"]}: {speak_start:.3f}s + {seconds:.3f}s, rate={rate}', flush=True)
    (OUT / 'demo.ass').write_text(header + '\n'.join(events) + '\n', encoding='utf-8-sig')
    peak = max(abs(v) for v in audio)
    gain = 32767 * 10**(-3/20) / peak
    audio = array.array('h', (round(v * gain) for v in audio))
    with wave.open(str(OUT / 'narration.wav'), 'wb') as w:
        w.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        w.writeframes(audio.tobytes())
    run([FF, '-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', OUT / 'frames.ffconcat',
         '-i', OUT / 'narration.wav', '-vf', 'fps=25,pad=1920:1080:(ow-iw)/2:64:color=0xf6f7f2,ass=demo.ass,scale=in_range=pc:out_range=tv,format=yuv420p',
         '-map', '0:v:0', '-map', '1:a:0', '-r', '25', '-t', str(duration), '-c:v', 'libx264',
         '-preset', 'veryfast', '-crf', '18', '-threads', '4', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
         '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', FINAL], OUT / 'encode.log')
    probe = json.loads(run([FF.with_name('ffprobe.EXE'), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', FINAL]))
    assert abs(float(probe['format']['duration']) - duration) < .05
    v = next(s for s in probe['streams'] if s['codec_type'] == 'video')
    a = next(s for s in probe['streams'] if s['codec_type'] == 'audio')
    assert v['codec_name'] == 'h264' and v['pix_fmt'] == 'yuv420p' and a['codec_name'] == 'aac'
    assert (v['width'], v['height']) == (1920, 1080)
    run([FF, '-v', 'error', '-i', FINAL, '-f', 'null', '-'], OUT / 'decode-check.log')
    run([FF, '-hide_banner', '-i', FINAL, '-vn', '-af', 'silencedetect=noise=-40dB:d=0.5,astats=metadata=0:reset=0', '-f', 'null', '-'], OUT / 'audio-statistics.log')
    for label, t in [('first', 1), ('middle', 16), ('success', 29.5), ('last', 34)]:
        run([FF, '-y', '-hide_banner', '-ss', str(t), '-i', FINAL, '-frames:v', '1', OUT / f'check-{label}.png'], OUT / f'check-{label}.log')
    shutil.copy2(Path(__file__), SRC / 'build_demo_video.py')
    shutil.copy2(ROOT / 'artifacts/video/source/synthesize.ps1', SRC / 'synthesize.ps1')
    receipt = {'status': 'encoded_and_decoded', 'final': str(FINAL), 'sha256': sha(FINAL), 'bytes': FINAL.stat().st_size,
               'recording_json': str(RAW / 'recording.json'), 'recording_sha256': sha(RAW / 'recording.json'),
               'source': data['source'], 'timing_basis': 'frame.received milliseconds',
               'raw_span_seconds': span, 'metadata_span_seconds': frames[-1]['timestamp'] - frames[0]['timestamp'],
               'playback_speed': .5, 'slow_motion_factor': 2, 'intro_seconds': 2, 'outro_seconds': 2,
               'exact_timeline_seconds': exact, 'encoded_duration_seconds': duration, 'cfr_quantization_seconds': duration-exact,
               'frames': timeline, 'actions': actions, 'voice': 'Microsoft Huihui Desktop', 'narration': voice_segments,
               'audio_peak_dbfs': 20 * math.log10(max(abs(v) for v in audio) / 32768),
               'audio_clipped_samples': sum(abs(v) >= 32767 for v in audio), 'human_listening': 'not performed',
               'frame_transform': '原生1600×867界面无缩放放在1920×1080画布x=160,y=64；字幕位于上下外部留白。',
               'probe': probe, 'commands': COMMANDS, 'full_decode': 'passed',
               'capture_note': '录制末尾尝试聚焦研究标题失败；finally保存的真实6动作成功流程与结算有效。',
               'source_files': {p.name: sha(p) for p in SRC.iterdir() if p.is_file()}}
    dump(OUT / 'receiptDemo.json', receipt)
    (OUT / '导出说明.md').write_text(f'CampusEcho 系统运行演示使用Edge Page.screencastFrame采集的74张真实界面帧。按frame.received毫秒时间戳的逐帧差值恢复15.512秒的原始时间线，再以0.5×速度播放，即2×慢放。片头与片尾各停留2秒，成片{duration:.2f}秒；25帧每秒的编码量化补齐约{duration-exact:.3f}秒。\n\n界面以原生1600×867尺寸保留，字幕置于1920×1080画布的外部留白。游戏时间保留T+20、24、28、30、32、36、43，结算为剩余17分钟、同行完成。最后保留实际行动记录与研究面板。中文说明由本机Huihui合成；声学统计已记录，未人工试听。\n\n原帧、recording.json、字幕、讲稿、语音脚本、时间线、SHA-256和FFmpeg命令保存在source与receiptDemo.json。重建命令为项目根目录运行`.repro-venv/Scripts/python.exe tools/build_demo_video.py`。录制最后的研究标题聚焦异常发生在成功流程后，成功结算画面与完整保存的footage有效。\n', encoding='utf-8')
    print(json.dumps({'final': str(FINAL), 'duration': duration, 'bytes': FINAL.stat().st_size}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
