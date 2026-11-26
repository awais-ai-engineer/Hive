/** Participant-owned recognition and acknowledged text delivery. Never recognizes remote audio. */
import { captionParts } from '@hive/shared';

export type TranscriptSegment = { channelId: string; sessionId: string; segmentId: string; sequence: number; revision: number; text: string; final: boolean };
export type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start(track?: MediaStreamTrack): void; stop(): void;
  onstart: (() => void) | null; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null };
export const recognitionClass = () => typeof window === 'undefined' ? null :
  ((window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
   (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition ?? null);
type Options = {
  userId: string; channelId: string; sessionId: string; language: () => string;
  track: () => MediaStreamTrack | null; connected: () => boolean;
  send: (segment: TranscriptSegment) => Promise<void>;
  local: (segment: TranscriptSegment) => void;
  status: (state: string, reason?: string) => void;
};

export class SpeechCapture {
  private disposed = false;
  private desired = false;
  private paused = false;
  private recognizer: Recognition | null = null;
  private restarting: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ending: (() => void)[] = [];
  private failures = 0;
  private sequence = 0;
  private sending = false;
  private queue = new Map<string, TranscriptSegment>();
  private storageKey: string;
  constructor(private options: Options) {
    this.storageKey = `hive:transcript-outbox:${options.userId}:${options.sessionId}`;
    try {
      const saved = JSON.parse(sessionStorage.getItem(this.storageKey) || 'null');
      if (saved?.expires > Date.now() && Array.isArray(saved.segments)) for (const segment of saved.segments) {
        if (segment.sessionId === options.sessionId && segment.channelId === options.channelId && segment.final) {
          this.queue.set(segment.segmentId, segment); this.sequence = Math.max(this.sequence, segment.sequence);
        }
      }
    } catch { /* memory outbox remains available when storage is disabled */ }
  }
  get pending() { return this.queue.size; }
  private persist() {
    try {
      if (!this.queue.size) sessionStorage.removeItem(this.storageKey);
      else sessionStorage.setItem(this.storageKey, JSON.stringify({ expires: Date.now() + 86400000, segments: [...this.queue.values()] }));
    } catch { this.options.status('error', 'Unsent captions could not be saved on this device. Keep this page open until they synchronize.'); }
  }
  start(paused = false) { this.desired = true; this.paused = paused; if (!paused) this.begin(); this.flush(); }
  pause(reason = 'Microphone capture paused') {
    this.paused = true;
    if (this.restarting) clearTimeout(this.restarting); this.restarting = null;
    this.options.status('paused', reason);
    try { this.recognizer?.stop(); } catch { /* end may already be pending */ }
  }
  resume() { this.paused = false; if (this.desired && !this.recognizer) this.begin(); this.flush(); }
  restart() { this.pause('Audio input or language changed'); this.paused = false; if (!this.recognizer) this.begin(); }
  private begin() {
    if (!this.desired || this.paused || this.recognizer) return;
    const Speech = recognitionClass();
    if (!Speech) { this.options.status('failed', 'Browser speech recognition is unavailable. A self-hosted transcription worker is required for this browser.'); return; }
    const recognizer = new Speech();
    const epoch = crypto.randomUUID();
    const results = new Map<number, { sequence: number; text: string; final: boolean; revision: number }>();
    this.recognizer = recognizer;
    recognizer.lang = this.options.language(); recognizer.continuous = true; recognizer.interimResults = true;
    this.options.status('starting');
    recognizer.onstart = () => { this.failures = 0; this.options.status('listening'); };
    recognizer.onresult = event => {
      // stop() can deliver final results asynchronously. These are authorized speech and must drain.
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]; const text = result[0]?.transcript.trim();
        const old = results.get(index);
        if (!text || old?.final || (old?.text === text && !result.isFinal)) continue;
        const record = { sequence: old?.sequence ?? ++this.sequence, text, final: result.isFinal, revision: (old?.revision ?? 0) + 1 };
        results.set(index, record);
        const parts = captionParts(text);
        (result.isFinal ? parts : parts.slice(0, 1)).forEach((part, partIndex) => {
          const segment: TranscriptSegment = { channelId: this.options.channelId, sessionId: this.options.sessionId,
            segmentId: `${epoch}_${index}_${partIndex}`, sequence: record.sequence, revision: record.revision, text: part, final: result.isFinal };
          this.options.local(segment);
          if (segment.final) this.queue.set(segment.segmentId, segment);
          else if (this.options.connected()) void this.options.send(segment).catch(() => {});
        });
        this.persist(); this.flush();
        if (this.queue.size > 5000) { this.desired = false; this.pause('Caption delivery is backlogged. Reconnect before continuing transcription.'); this.options.status('failed', 'Caption outbox is full; capture stopped without clearing finalized text.'); }
      }
    };
    recognizer.onerror = ({ error }) => {
      this.failures++;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(error) || this.failures >= 6) {
        this.desired = false;
        this.options.status('failed', `Speech recognition failed (${error}). Check the microphone and selected language before restarting transcription.`);
      } else this.options.status('interrupted', `Speech recognition was interrupted (${error}); capture will retry.`);
    };
    recognizer.onend = () => {
      if (this.recognizer !== recognizer) return;
      if ([...results.values()].some(result => !result.final)) this.options.status('interrupted', 'The recognizer ended with unfinalized speech. That speech is not included in finalized notes.');
      this.recognizer = null; this.ending.splice(0).forEach(resolve => resolve());
      if (this.desired && !this.paused) this.restarting = setTimeout(() => { this.restarting = null; this.begin(); }, Math.min(5000, 150 * 2 ** Math.min(5, this.failures)));
    };
    try { recognizer.start(this.options.track() ?? undefined); }
    catch (cause) {
      this.recognizer = null; this.failures++;
      this.options.status('error', cause instanceof Error ? cause.message : 'Speech recognition could not start.');
      if (this.desired && !this.paused && this.failures < 6) this.restarting = setTimeout(() => { this.restarting = null; this.begin(); }, 500 * this.failures);
    }
  }
  flush() {
    if (this.disposed || this.sending || !this.options.connected() || !this.queue.size) return;
    this.sending = true; const segment = this.queue.values().next().value!;
    void this.options.send(segment).then(() => { this.queue.delete(segment.segmentId); this.persist(); }).catch(() => {
      this.options.status('interrupted', 'Finalized speech is waiting to synchronize. It has not been discarded.');
    }).finally(() => {
      this.sending = false;
      if (this.queue.size && !this.disposed) this.retry = setTimeout(() => { this.retry = null; this.flush(); }, 500);
    });
  }
  async stop(timeout = 4000) {
    this.desired = false; this.paused = true;
    if (this.restarting) clearTimeout(this.restarting); this.restarting = null;
    this.options.status('draining');
    if (this.recognizer) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.options.status('interrupted', 'The recognizer did not finalize before its stop deadline.'); resolve(); }, 2000);
      this.ending.push(() => { clearTimeout(timer); resolve(); });
      try { this.recognizer?.stop(); } catch { clearTimeout(timer); resolve(); }
    });
    const until = Date.now() + timeout; this.flush();
    while (this.queue.size && this.options.connected() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    this.options.status(this.queue.size ? 'error' : 'stopped', this.queue.size ? `${this.queue.size} finalized caption segments remain unsynchronized.` : undefined);
    return !this.queue.size;
  }
  dispose(clear = false) {
    this.disposed = true; this.desired = false; this.paused = true;
    if (this.restarting) clearTimeout(this.restarting);
    if (this.retry) clearTimeout(this.retry);
    if (this.recognizer) { this.recognizer.onend = this.recognizer.onresult = this.recognizer.onerror = null; try { this.recognizer.stop(); } catch { /* ended */ } }
    this.recognizer = null;
    if (clear) { this.queue.clear(); this.persist(); }
  }
}
