/* Original Hive PCM windowing processor. No remote audio, dependencies or audible output. */
class HuddlePCM extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = []; this.base = 0; this.sum = 0; this.weight = 0; this.paused = false;
    this.port.onmessage = ({ data }) => {
      if (data.pause || data.stop) { this.flush(true); this.paused = true; this.port.postMessage({ done: true }); }
      if (data.resume) { this.samples = []; this.base = 0; this.sum = 0; this.weight = 0; this.paused = false; }
    };
  }
  flush(final) {
    if (!this.samples.length) return;
    const pcm = Float32Array.from(this.samples);
    this.port.postMessage({ samples: pcm, startMs: this.base / 16, final }, [pcm.buffer]);
    if (final) { this.samples = []; this.base = 0; }
    else { this.samples = this.samples.slice(64000); this.base += 64000; }
  }
  process(inputs) {
    if (this.paused) return true;
    const input = inputs[0]?.[0]; if (!input) return true;
    const ratio = sampleRate / 16000;
    for (const sample of input) {
      let remaining = 1;
      while (remaining > .000001) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= ratio - .000001) { this.samples.push(this.sum / ratio); this.sum = 0; this.weight = 0; }
      }
      if (this.samples.length >= 80000) this.flush(false);
    }
    return true;
  }
}
registerProcessor('huddle-pcm', HuddlePCM);
