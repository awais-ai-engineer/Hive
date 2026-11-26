'use client';
import { apiFetch, responseData } from './api';
import { socket } from './socket';
import type { Caption } from './call';

type Frame = { samples: Float32Array; startMs: number; final: boolean };
function wav(samples: Float32Array) {
  const buffer = new ArrayBuffer(44 + samples.length * 2); const view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([buffer], { type: 'audio/wav' });
}
type Options = { channelId: string; sessionId: string; track: () => MediaStreamTrack | null; language: () => string;
  connected: () => boolean; local: (segment: Caption & { segmentId: string }) => void; status: (state: string, reason?: string) => void };
/** Exact selected microphone capture. Audio stays in bounded RAM until acknowledged, then is discarded. */
export class PcmCapture {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private desired = false;
  private paused = true;
  private disposed = false;
  private starting = false;
  private runId = crypto.randomUUID();
  private sequence = 0;
  private pausePending = false;
  private resumePending = false;
  private queue: { id: string; sequence: number; run: string; language: string; frame: Frame }[] = [];
  private sending = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopping: (() => void) | null = null;
  get pending() { return this.queue.length; }
  constructor(private options: Options) {}
  start(paused = false) { this.desired = true; this.paused = paused; void this.initialize(); }
  private async initialize() {
    if (this.node || this.starting || this.disposed) return;
    this.starting = true; this.options.status('starting');
    try {
      const track = this.options.track(); if (!track || track.readyState !== 'live') throw new Error('The selected microphone is unavailable.');
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule('/worklets/huddle-pcm.js');
      await this.context.resume();
      if (this.disposed) { await this.context.close(); return; }
      this.source = this.context.createMediaStreamSource(new MediaStream([track]));
      this.node = new AudioWorkletNode(this.context, 'huddle-pcm');
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node).connect(this.gain).connect(this.context.destination);
      this.node.port.onmessage = ({ data }: MessageEvent<Frame & { done?: boolean }>) => {
        if (data.done) { this.pausePending = false; this.stopping?.(); this.stopping = null; if (this.resumePending) { this.resumePending = false; this.resume(); } return; }
        const sequence = ++this.sequence;
        this.queue.push({ id: `audio_${this.runId}_${sequence}`, sequence, run: this.runId, language: this.options.language(), frame: data }); this.flush();
        if (this.queue.length >= 16) { this.pause('Speech processing is backlogged; capture paused to limit private audio in memory.'); this.options.status('error', 'Speech processing is backlogged. Reconnect or stop transcription before continuing.'); }
      };
      if (this.paused || !this.desired) this.node.port.postMessage({ pause: true });
      else this.options.status('listening');
    } catch (cause) { this.source?.disconnect(); this.node?.disconnect(); this.gain?.disconnect(); void this.context?.close().catch(() => {}); this.node = null; this.context = null; this.options.status('error', cause instanceof Error ? cause.message : 'Microphone processing failed.'); }
    finally { this.starting = false; }
  }
  pause(reason = 'Microphone capture paused') { this.paused = true; this.resumePending = false; if (this.node && !this.pausePending) { this.pausePending = true; this.node.port.postMessage({ pause: true }); } this.options.status('paused', reason); }
  resume() {
    if (!this.desired || this.disposed) return;
    if (this.pausePending) { this.resumePending = true; return; }
    if (!this.paused) { this.flush(); return; }
    this.paused = false; this.runId = crypto.randomUUID();
    this.node?.port.postMessage({ resume: true }); this.options.status('listening'); this.flush();
  }
  restart() {
    this.pause('Audio input or language changed');
    const track = this.options.track();
    if (this.context && this.node && track) { this.source?.disconnect(); this.source = this.context.createMediaStreamSource(new MediaStream([track])); this.source.connect(this.node); }
    this.resume();
  }
  flush() {
    if (this.disposed || this.sending || !this.queue.length || !this.options.connected()) return;
    this.sending = true; const entry = this.queue[0];
    const data = new FormData(); data.set('channel_id', this.options.channelId); data.set('sid', socket.id ?? '');
    data.set('run_id', entry.run); data.set('chunk_id', entry.id); data.set('sequence', String(entry.sequence));
    data.set('start_ms', String(Math.round(entry.frame.startMs))); data.set('final', String(entry.frame.final));
    data.set('language', entry.language); data.set('audio', wav(entry.frame.samples), 'speech.wav');
    void apiFetch(`/api/calls/sessions/${this.options.sessionId}/audio`, { method: 'POST', body: data })
      .then(responseData<{ segment: (Caption & { segmentId: string }) | null }>).then(result => {
        if (result.segment) this.options.local(result.segment); this.queue.shift();
      }).catch(() => { if (!this.disposed) this.options.status('interrupted', 'Speech processing is waiting to retry. Private audio is retained only in bounded memory.'); })
      .finally(() => { this.sending = false; if (this.queue.length && !this.disposed) this.retry = setTimeout(() => this.flush(), 1000); });
  }
  async stop(timeout = 5000) {
    this.desired = false; this.paused = true; this.resumePending = false;
    this.options.status('draining');
    if (this.node) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1000); this.stopping = () => { clearTimeout(timer); resolve(); };
      this.node!.port.postMessage({ stop: true });
    });
    this.flush(); const until = Date.now() + timeout;
    while (this.queue.length && this.options.connected() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    this.options.status(this.queue.length ? 'error' : 'stopped', this.queue.length ? 'Audio windows remain unprocessed. Leaving now will produce an incomplete transcript.' : undefined);
    return !this.queue.length;
  }
  dispose(_clear = false) {
    this.disposed = true; this.desired = false; if (this.retry) clearTimeout(this.retry);
    this.source?.disconnect(); this.node?.disconnect(); this.gain?.disconnect();
    void this.context?.close().catch(() => {}); this.queue.length = 0;
  }
}
