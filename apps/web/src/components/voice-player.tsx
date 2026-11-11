'use client';

import { Button as UiButton } from '@hive/ui';

import { useRef, useState } from 'react';
import type { Attachment } from '@hive/shared';
import { mediaUrl } from './posts/media-gallery';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function VoicePlayer({ attachment }: { attachment: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState((attachment.durationMs ?? 0) / 1000);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState('');
  const peaks = attachment.waveform ?? Array.from({ length: 64 }, () => 20);
  function seek(value: number) {
    if (!audio.current || !duration) return;
    audio.current.currentTime = Math.max(0, Math.min(duration, value));
    setElapsed(audio.current.currentTime);
  }
  return <div className="my-2 flex max-w-md flex-wrap items-center gap-2 rounded-xl bg-brand-soft p-3">
    <audio ref={audio} src={mediaUrl(attachment.url)} preload="metadata"
      onTimeUpdate={event => setElapsed(event.currentTarget.currentTime)}
      onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => setError('This recording could not be played.')} />
    <UiButton type="button" className="btn-ghost rounded-lg px-2 py-1 text-brand" aria-label={playing ? 'Pause recording' : 'Play recording'} tooltip={playing ? 'Pause recording' : 'Play recording'}
      onClick={() => { if (playing) audio.current?.pause(); else void audio.current?.play().catch(() => setError('This recording could not be played.')); }}>{playing ? 'Ⅱ' : '▶'}</UiButton>
    <div role="slider" tabIndex={0} aria-label="Recording position" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.floor(elapsed)} aria-valuetext={`${clock(elapsed)} of ${clock(duration)}`}
      className="flex h-9 min-w-24 flex-1 cursor-pointer items-center gap-px rounded focus-visible:outline-2 focus-visible:outline-brand"
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); seek((event.clientX - rect.left) / rect.width * duration); }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); seek(event.key === 'Home' ? 0 : event.key === 'End' ? duration : elapsed + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -5 : 5)); } }}>
      {peaks.map((peak, i) => <span key={i} className={`min-w-px flex-1 rounded-full ${i / peaks.length <= elapsed / (duration || 1) ? 'bg-brand' : 'bg-brand/30'}`} style={{ height: `${Math.max(8, peak)}%` }} />)}
    </div>
    <span className="text-xs tabular-nums text-white/60">{clock(elapsed)} / {clock(duration)}</span>
    <UiButton type="button" className="btn-ghost rounded px-1 text-xs" aria-label={`Playback speed ${speed} times`} tooltip="Change playback speed" onClick={() => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (audio.current) audio.current.playbackRate = next; }}>{speed}×</UiButton>
    {error && <p role="alert" className="w-full text-xs text-rose-500">{error}</p>}
  </div>;
}
