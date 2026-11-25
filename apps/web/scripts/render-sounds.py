"""Render Hive's original acoustic-inspired cues. Python stdlib only; no runtime synthesis.

Each score uses different timing, instrumentation, articulation and voicing. Shared materials
are felt mallets, glass partials, woody taps and filtered air, rather than shifted beeps.
"""
import array
import hashlib
import json
import math
from pathlib import Path
import random
import wave

ROOT = Path(__file__).resolve().parents[1] / "public/sounds/v2"
RATE = 24000
# instrument, frequency, onset, duration, amplitude
SCORES = {
    "incoming": [("felt", 587, 0, .42, 1), ("glass", 880, .13, .48, .42), ("air", 0, 0, .12, .12)],
    "channel_message": [("wood", 784, 0, .18, .8), ("felt", 1175, .045, .24, .22)],
    "message_sent": [("pop", 280, 0, .10, 1), ("wood", 1400, .012, .07, .12)],
    "mention": [("glass", 698, 0, .38, .8), ("felt", 1047, 0, .28, .3), ("glass", 1047, .22, .48, .8)],
    "reply": [("felt", 659, 0, .24, .65), ("wood", 988, .13, .21, .6), ("felt", 784, .21, .32, .3)],
    "message_failed": [("wood", 330, 0, .16, .6), ("felt", 294, .11, .36, .8)],
    "priority": [("glass", 784, 0, .42, .7), ("glass", 1175, .17, .48, .8), ("felt", 1568, .38, .5, .45)],
    "invitation": [("felt", 587, 0, .55, .8), ("glass", 880, .16, .65, .5), ("felt", 740, .42, .52, .7), ("glass", 1175, .62, .7, .4), ("air", 0, 0, 1.1, .08)],
    "outgoing": [("felt", 392, 0, .65, .7), ("felt", 494, .15, .8, .35)],
    "huddle_start": [("felt", 392, 0, .4, .55), ("felt", 587, .09, .46, .7), ("glass", 784, .2, .58, .45)],
    "huddle_end": [("glass", 784, 0, .28, .45), ("felt", 587, .12, .3, .7), ("felt", 392, .29, .5, .65)],
    "participant_join": [("wood", 880, 0, .13, .35), ("felt", 1175, .07, .32, .8)],
    "participant_leave": [("felt", 784, 0, .2, .7), ("wood", 523, .14, .24, .7)],
    "microphone_mute": [("wood", 190, 0, .095, .8), ("air", 0, 0, .045, .22)],
    "microphone_on": [("pop", 620, 0, .075, .7), ("glass", 1245, .02, .12, .3)],
    "camera_on": [("air", 0, 0, .15, .3), ("felt", 830, .045, .22, .8), ("glass", 1660, .07, .17, .2)],
    "camera_off": [("wood", 415, 0, .12, .7), ("air", 0, .025, .19, .2)],
    "hand_on": [("glass", 988, 0, .35, .75), ("wood", 1480, .17, .2, .6)],
    "hand_off": [("felt", 740, 0, .18, .6), ("air", 0, .04, .17, .2)],
    "screen_on": [("air", 0, 0, .28, .15), ("felt", 523, 0, .3, .6), ("glass", 784, .10, .35, .7), ("glass", 1047, .23, .36, .4)],
    "screen_off": [("glass", 988, 0, .22, .4), ("felt", 659, .07, .3, .65), ("wood", 330, .21, .18, .5)],
    "connection_lost": [("felt", 440, 0, .3, .8), ("wood", 415, .3, .25, .5), ("felt", 349, .38, .4, .5)],
    "reconnection": [("wood", 440, 0, .14, .4), ("felt", 659, .14, .3, .7), ("glass", 880, .28, .45, .4)],
    "declined": [("felt", 494, 0, .3, .7), ("felt", 370, .24, .4, .65)],
    "unanswered": [("glass", 659, 0, .4, .45), ("wood", 494, .27, .15, .6), ("felt", 330, .39, .4, .55)],
    "captions_start": [("wood", 698, 0, .10, .5), ("felt", 1047, .06, .2, .65)],
    "captions_stop": [("wood", 587, 0, .09, .6), ("air", 0, .04, .16, .2)],
    "workspace_invite": [("felt", 440, 0, .3, .7), ("glass", 659, .15, .42, .6), ("wood", 880, .3, .18, .4)],
    "community_invite": [("wood", 523, 0, .16, .5), ("felt", 784, .12, .36, .7), ("glass", 1175, .3, .35, .35)],
    "invite_accepted": [("pop", 440, 0, .1, .4), ("glass", 880, .08, .35, .7), ("felt", 1109, .2, .35, .4)],
    "join_request": [("wood", 659, 0, .14, .7), ("wood", 659, .15, .16, .55), ("felt", 988, .24, .3, .4)],
    "member_join": [("felt", 554, 0, .24, .7), ("glass", 830, .08, .3, .3)],
    "task_assigned": [("wood", 740, 0, .16, .7), ("felt", 988, .11, .32, .7), ("air", 0, .04, .16, .12)],
    "meeting_reminder": [("glass", 523, 0, .5, .6), ("glass", 1047, .26, .55, .6), ("felt", 784, .49, .4, .4)],
    "deadline": [("wood", 587, 0, .14, .5), ("glass", 880, .12, .42, .65), ("glass", 1175, .33, .42, .55)],
    "system": [("felt", 698, 0, .4, .65), ("glass", 932, .23, .48, .5)],
    "success": [("pop", 523, 0, .085, .6), ("felt", 1047, .07, .25, .6)],
    "warning": [("wood", 392, 0, .13, .6), ("glass", 523, .15, .36, .5)],
    "error": [("pop", 220, 0, .09, .5), ("wood", 294, .10, .17, .7), ("felt", 262, .19, .26, .5)],
}


def render(name, score):
    rng = random.Random(name)
    data = [0.] * int((max(t + length for _, _, t, length, _ in score) + .12) * RATE)
    for kind, frequency, onset, duration, amplitude in score:
        filtered = 0.
        for i in range(int(duration * RATE)):
            t = i / RATE
            envelope = (1 - math.exp(-t / (.012 if kind in ('felt', 'air') else .003))) * math.exp(-t / (duration / 4))
            fade = min(1, (duration - t) / .025)
            phase = 2 * math.pi * frequency * t
            if kind == 'felt':
                value = math.sin(phase) + .22 * math.sin(phase * 2.01) * math.exp(-t * 15) + .08 * math.sin(phase * 3.98)
            elif kind == 'glass':
                value = .72 * math.sin(phase) + .20 * math.sin(phase * 2.76) * math.exp(-t * 7) + .08 * math.sin(phase * 4.12) * math.exp(-t * 12)
            elif kind == 'wood':
                value = math.sin(phase * (1 + .16 * math.exp(-t * 65))) * math.exp(-t * 18) + .3 * math.sin(phase * 1.58) * math.exp(-t * 30)
            elif kind == 'pop':
                value = math.sin(phase + 2.5 * (1 - math.exp(-t * 80))) * math.exp(-t * 28)
            else:
                filtered += .10 * (rng.uniform(-1, 1) - filtered)
                value = filtered * 2
            data[int(onset * RATE) + i] += amplitude * envelope * fade * value
    # Short damped room reflections add depth without a long notification tail.
    dry = data[:]
    for delay, amount in [(.027, .10), (.051, .05)]:
        offset = int(delay * RATE)
        for i in range(offset, len(data)):
            data[i] += dry[i - offset] * amount
    rms = math.sqrt(sum(v*v for v in data) / len(data))
    scale = min(.12 / max(rms, .001), .68 / max(abs(v) for v in data))
    pcm = array.array('h', [round(v * scale * 32767) for v in data])
    path = ROOT / f'{name}.wav'
    with wave.open(str(path), 'wb') as out:
        out.setparams((1, 2, RATE, 0, 'NONE', 'not compressed')); out.writeframes(pcm.tobytes())
    return {"file": path.name, "seconds": round(len(data)/RATE, 3), "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    manifest = [render(name, score) for name, score in SCORES.items()]
    (ROOT / 'effects.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Rendered {len(manifest)} original cues, {sum(row["bytes"] for row in manifest)} bytes')
