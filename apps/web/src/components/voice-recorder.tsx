'use client';

import { Button as UiButton } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui/icons';

type Props = { onReady: (file: File, durationMs: number, waveform: number[]) => Promise<boolean | void> | boolean | void; onError: (message: string) => void; disabled?: boolean };

export function VoiceRecorder({ onReady, onError, disabled = false }: Props) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'preparing' | 'review'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState<{ file: File; duration: number; peaks: number[]; url: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const canceled = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const previewUrl = useRef('');
  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    void context.current?.close().catch(() => {}); context.current = null;
  }
  function cancel() {
    canceled.current = true;
    generation.current += 1;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = ''; setReady(null); setPhase('idle');
  }
  useEffect(() => {
    mounted.current = true;
    setSupported(typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
    return () => { mounted.current = false; canceled.current = true; if (recorder.current?.state === 'recording') recorder.current.stop(); release(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); };
  }, []);
  async function start() {
    setPhase('starting'); canceled.current = false; setSeconds(0);
    const currentGeneration = ++generation.current;
    try {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current || canceled.current || currentGeneration !== generation.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('Unsupported recording format');
      const recording = new MediaRecorder(input, { mimeType: mime }); recorder.current = recording;
      const chunks: Blob[] = []; const started = Date.now();
      const live = new AudioContext(); context.current = live;
      const analyser = live.createAnalyser(); analyser.fftSize = 256;
      live.createMediaStreamSource(input).connect(analyser);
      const levels = new Uint8Array(analyser.frequencyBinCount);
      recording.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recording.onstop = async () => {
        if (canceled.current || !mounted.current || currentGeneration !== generation.current) return;
        const duration = Math.min(300000, Math.max(1, Date.now() - started)); release();
        setPhase('preparing');
        try {
          const file = new File(chunks, `voice.${mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'}`, { type: mime });
          const decoder = new AudioContext();
          let peaks: number[];
          try {
            const decoded = await decoder.decodeAudioData(await file.arrayBuffer());
            const samples = decoded.getChannelData(0);
            peaks = Array.from({ length: 64 }, (_, index) => {
              let max = 0; const start = Math.floor(index * samples.length / 64); const end = Math.floor((index + 1) * samples.length / 64);
              for (let i = start; i < end; i++) max = Math.max(max, Math.abs(samples[i]));
              return Math.round(Math.min(1, max) * 100);
            });
          } finally { await decoder.close(); }
          if (canceled.current || !mounted.current || currentGeneration !== generation.current) return;
          const url = URL.createObjectURL(file); previewUrl.current = url;
          setReady({ file, duration, peaks, url }); setPhase('review');
        } catch { if (mounted.current && !canceled.current && currentGeneration === generation.current) { setPhase('idle'); onError('Could not prepare the recording. Please try again.'); } }
      };
      recording.onerror = () => { cancel(); onError('Recording stopped unexpectedly. Please try again.'); };
      recording.start(1000); setPhase('recording');
      timer.current = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000; setSeconds(Math.floor(elapsed));
        analyser.getByteTimeDomainData(levels);
        setLevel(Math.min(100, Math.max(...levels.map(value => Math.abs(value - 128))) * 2));
        if (elapsed >= 300 && recording.state === 'recording') recording.stop();
      }, 100);
    } catch (error) { release(); if (mounted.current) { setPhase('idle'); onError(error instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name) ? 'Microphone access was denied. Allow it in your browser to record a voice message.' : 'The microphone could not be started. Check that it is available.'); } }
  }
  if (!supported) return null;
  const button = 'btn-ghost rounded-lg px-2 py-1 text-xs';
  if (phase === 'idle') return <UiButton type="button" className={button} disabled={disabled} tooltip="Record voice message" aria-label="Record voice message" onClick={() => void start()}><Icon name="volume" size={18} /></UiButton>;
  return <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl bg-brand-soft p-2" aria-label="Voice recording">
    {phase === 'starting' && <span className="text-xs">Starting microphone…</span>}
    {phase === 'preparing' && <span className="text-xs">Preparing recording…</span>}
    {phase === 'recording' && <><span role="timer" className="text-xs tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span><meter min={0} max={100} value={level} aria-label="Microphone level" className="w-16" /><UiButton type="button" className={button} onClick={() => { if (recorder.current?.state === 'recording') { setPhase('preparing'); recorder.current.stop(); } }}>Stop and review</UiButton></>}
    {phase === 'review' && ready && <><audio src={ready.url} controls className="h-8 w-44 max-w-full" /><UiButton type="button" className={`${button} text-brand`} disabled={disabled || sending} onClick={async () => {
      if (sending) return;
      setSending(true);
      try { const result = await onReady(ready.file, ready.duration, ready.peaks); if (result !== false && mounted.current) cancel(); }
      catch { if (mounted.current) onError('Could not send the recording. Please try again.'); }
      finally { if (mounted.current) setSending(false); }
    }}>{sending ? 'Sending…' : 'Send recording'}</UiButton></>}
    <UiButton type="button" className={button} disabled={sending} onClick={cancel}>Cancel</UiButton>
  </div>;
}
