'use client';

import { Button as UiButton } from '@hive/ui';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui/icons';
import { withWebmDuration } from '../lib/webm-duration';
import { fixVideoDuration } from '../lib/video-duration';

type Props = { onReady: (file: File, durationMs: number) => Promise<boolean | void> | boolean | void; onError: (message: string) => void; disabled?: boolean };
const LIMIT_SECONDS = 180;

/** Records a short clip from the camera and microphone, with a preview before sending. */
export function VideoRecorder({ onReady, onError, disabled = false }: Props) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'review'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState<{ file: File; duration: number; url: string } | null>(null);
  const live = useRef<HTMLVideoElement | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const canceled = useRef(false);
  const previewUrl = useRef('');

  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    if (live.current) live.current.srcObject = null;
  }
  function cancel() {
    canceled.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = ''; setReady(null); setPhase('idle');
  }
  useEffect(() => {
    setSupported(typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
    return () => { canceled.current = true; if (recorder.current?.state === 'recording') recorder.current.stop(); release(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, []);
  useEffect(() => { if (phase === 'recording' && live.current && stream.current) live.current.srcObject = stream.current; }, [phase]);

  async function start() {
    setPhase('starting'); canceled.current = false; setSeconds(0);
    try {
      const input = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true });
      if (canceled.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('Unsupported recording format');
      const recording = new MediaRecorder(input, { mimeType: mime, videoBitsPerSecond: 2_000_000 }); recorder.current = recording;
      const chunks: Blob[] = []; const started = Date.now();
      recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recording.onstop = async () => {
        if (canceled.current) return;
        const duration = Math.max(1, Date.now() - started); release();
        const file = await withWebmDuration(new File(chunks, `clip.${mime.includes('mp4') ? 'mp4' : 'webm'}`, { type: mime }), duration);
        if (canceled.current) return;
        const url = URL.createObjectURL(file); previewUrl.current = url;
        setReady({ file, duration, url }); setPhase('review');
      };
      recording.onerror = () => { cancel(); onError('Recording stopped unexpectedly. Please try again.'); };
      recording.start(1000); setPhase('recording');
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - started) / 1000); setSeconds(elapsed);
        if (elapsed >= LIMIT_SECONDS && recording.state === 'recording') recording.stop();
      }, 250);
    } catch (error) {
      release(); setPhase('idle');
      onError(error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name) ? 'Camera access was denied. Allow the camera and microphone to record a clip.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'No camera was found on this device.' : 'Could not start recording. Please try again.');
    }
  }
  async function send() {
    if (!ready) return;
    setSending(true);
    try { if (await onReady(ready.file, ready.duration) !== false) cancel(); }
    finally { setSending(false); }
  }

  if (!supported) return null;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (phase === 'idle') return <UiButton type="button" className="flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-white/70 hover:bg-brand-soft hover:text-brand disabled:opacity-40" disabled={disabled} tooltip="Record a video clip" aria-label="Record a video clip" onClick={() => void start()}><Icon name="video" size={18} /></UiButton>;
  return <div role="dialog" aria-label="Video clip" className="on-surface absolute bottom-full left-2 z-30 mb-2 w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-surface p-3 text-white shadow-[var(--shadow-pop)]">
    <div className="relative overflow-hidden rounded-xl bg-black">
      {phase === 'review' && ready ? <video key="review" src={ready.url} controls playsInline preload="auto" onLoadedMetadata={fixVideoDuration} className="aspect-video w-full bg-black" />
        : <video key="live" ref={live} muted autoPlay playsInline className="aspect-video w-full object-cover" />}
      {phase === 'recording' && <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-xs font-semibold text-white"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />{clock}</span>}
      {phase === 'starting' && <span className="absolute inset-0 flex items-center justify-center text-sm text-white/70">Starting camera…</span>}
    </div>
    <div className="mt-3 flex items-center justify-between gap-2 text-sm">
      <span className="text-white/60">{phase === 'review' ? `${clock} clip` : `Up to ${LIMIT_SECONDS / 60} minutes`}</span>
      <span className="flex gap-2">
        <UiButton type="button" className="btn-ghost px-3 py-1.5 text-sm" disabled={sending} onClick={cancel}>{phase === 'review' ? 'Discard' : 'Cancel'}</UiButton>
        {phase === 'recording' && <UiButton type="button" className="rounded-xl bg-rose-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-600" onClick={() => recorder.current?.state === 'recording' && recorder.current.stop()}>Stop</UiButton>}
        {phase === 'review' && <UiButton type="button" className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-strong disabled:opacity-40" disabled={sending} onClick={() => void send()}><Icon name="send" size={14} />{sending ? 'Sending…' : 'Send clip'}</UiButton>}
      </span>
    </div>
  </div>;
}
