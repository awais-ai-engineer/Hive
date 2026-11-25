"""Offline production tool; run in a separate piper-tts 1.4.1 environment.

python render-announcements.py /path/to/en_US-ljspeech-medium.onnx
The voice model and synthesis tools are not deployed or bundled with Hive.
"""
import array
import hashlib
import json
from pathlib import Path
import sys
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

ROOT = Path(__file__).resolve().parents[1] / 'public/sounds/v2'
TEXTS = {
    'notes_enabled': 'A. I. meeting notes are now enabled.',
    'notes_stopped': 'A. I. meeting notes have been stopped.',
    'recording_started': 'This meeting is now being recorded.',
    'recording_stopped': 'Meeting recording has stopped.',
    'transcription_started': 'Speech transcription is now enabled. Finalized captions will be saved as meeting notes.',
    'transcription_stopped': 'Speech transcription has stopped.',
    'transcription_active': 'Speech transcription is active in this Huddle. Finalized captions are saved as meeting notes.',
}

if __name__ == '__main__':
    voice = PiperVoice.load(sys.argv[1], use_cuda=False)
    manifest = []
    for event, text in TEXTS.items():
        path = ROOT / f'{event}.wav'
        with wave.open(str(path), 'wb') as out:
            voice.synthesize_wav(text, out, syn_config=SynthesisConfig(length_scale=1.04, noise_scale=.5, noise_w_scale=.6))
        with wave.open(str(path), 'rb') as source:
            rate = source.getframerate()
            samples = array.array('h', source.readframes(source.getnframes()))
        # Trim only leading/trailing silence, retain natural sentence pauses, avoid hard edges.
        audible = [i for i, value in enumerate(samples) if abs(value) > 180]
        if not audible:
            raise RuntimeError(f'Empty speech asset: {event}')
        samples = samples[max(0, audible[0] - int(rate * .06)):audible[-1] + int(rate * .12)]
        peak = max(abs(value) for value in samples)
        rms = (sum(float(value)**2 for value in samples) / len(samples))**.5
        scale = min(32767 * .72 / peak, 32767 * .13 / rms)
        samples = array.array('h', [round(value * scale * min(1, i / (rate * .008), (len(samples)-1-i) / (rate * .012))) for i, value in enumerate(samples)])
        with wave.open(str(path), 'wb') as out:
            out.setparams((1, 2, rate, 0, 'NONE', 'not compressed')); out.writeframes(samples.tobytes())
        manifest.append({'file': path.name, 'text': text, 'seconds': round(len(samples)/rate, 3), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    (ROOT / 'announcements.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Rendered {len(manifest)} speech assets', flush=True)
