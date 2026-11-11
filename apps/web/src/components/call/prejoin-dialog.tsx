'use client';

import { Button as UiButton, Dialog } from '@hive/ui';
import { useEffect, useRef, useState } from 'react';
import { calls } from '../../lib/call';
import { Icon } from '../ui/icons';

type Pending = { channelId: string; title: string; resolve: (choice: { muted: boolean; camera: boolean } | null) => void };

/**
 * Shown before every huddle join: a live camera preview with mic and camera switches, so people
 * can check how they look and sound before anyone hears them.
 */
export function PrejoinDialog() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(false);
  const [note, setNote] = useState('');
  const [level, setLevel] = useState(0);
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const meter = useRef<{ context: AudioContext; timer: ReturnType<typeof setInterval> } | null>(null);

  useEffect(() => {
    calls.beforeJoin = (channelId, title) => new Promise(resolve => { setMuted(false); setCamera(false); setNote(''); setPending({ channelId, title, resolve }); });
    return () => { calls.beforeJoin = null; };
  }, []);

  function stopPreview() {
    if (meter.current) { clearInterval(meter.current.timer); void meter.current.context.close().catch(() => {}); meter.current = null; }
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
    if (video.current) video.current.srcObject = null;
    setLevel(0);
  }

  // Open the preview when the dialog appears; the camera switch adds or removes the video track.
  useEffect(() => {
    if (!pending) { stopPreview(); return; }
    let cancelled = false;
    (async () => {
      stopPreview();
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: camera ? { width: 640, height: 360 } : false });
        if (cancelled) { media.getTracks().forEach(track => track.stop()); return; }
        stream.current = media;
        if (video.current) video.current.srcObject = media;
        const context = new AudioContext(); const analyser = context.createAnalyser(); analyser.fftSize = 256;
        context.createMediaStreamSource(media).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const timer = setInterval(() => { analyser.getByteTimeDomainData(data); setLevel(Math.min(100, Math.max(...data.map(value => Math.abs(value - 128))) * 2)); }, 120);
        meter.current = { context, timer };
        setNote('');
      } catch (cause) {
        if (cancelled) return;
        const denied = cause instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(cause.name);
        if (camera) { setCamera(false); setNote(denied ? 'Camera access was denied. You can still join with audio.' : 'No camera found. You can still join with audio.'); }
        else setNote(denied ? 'Microphone access was denied. You can join muted and listen.' : 'No microphone found. You can join and listen.');
      }
    })();
    return () => { cancelled = true; };
  }, [pending, camera]);

  function finish(choice: { muted: boolean; camera: boolean } | null) {
    const current = pending; setPending(null); stopPreview(); current?.resolve(choice);
  }

  const control = (on: boolean, icon: 'mic' | 'video', label: string, toggle: () => void) =>
    <UiButton type="button" onClick={toggle} aria-pressed={on} tooltip={label} aria-label={label}
      style={{ background: on ? 'rgb(255 255 255 / 0.18)' : '#f43f5e', color: '#fff' }}
      className="flex h-12 w-12 items-center justify-center rounded-full transition hover:brightness-110">
      <Icon name={icon} size={20} />{!on && <span aria-hidden className="absolute h-7 w-0.5 rotate-45 rounded bg-white" />}
    </UiButton>;

  return <Dialog open={!!pending} onOpenChange={open => { if (!open) finish(null); }} title={pending?.title || 'Join huddle'} description="Check your mic and camera before you join." className="max-w-lg">
    <div className="relative aspect-video overflow-hidden rounded-2xl bg-[#15171c]">
      <video ref={video} muted autoPlay playsInline className={`h-full w-full object-cover ${camera ? '' : 'hidden'}`} />
      {!camera && <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: 'rgb(255 255 255 / 0.6)' }}><Icon name="video" size={34} /><span className="text-sm">Camera is off</span></div>}
      <span aria-hidden className="absolute bottom-3 left-3 flex h-6 items-end gap-0.5">{[0.3, 0.6, 1].map(step => <span key={step} className="w-1.5 rounded-sm bg-emerald-400 transition-all" style={{ height: `${6 + (level >= step * 60 ? 14 : 0)}px`, opacity: muted ? 0.3 : 1 }} />)}</span>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-3">
        <span className="relative flex">{control(!muted, 'mic', muted ? 'Unmute microphone' : 'Mute microphone', () => setMuted(value => !value))}</span>
        <span className="relative flex">{control(camera, 'video', camera ? 'Turn camera off' : 'Turn camera on', () => setCamera(value => !value))}</span>
      </div>
    </div>
    {note && <p role="status" className="mt-3 text-sm text-amber-500">{note}</p>}
    <div className="mt-4 flex items-center justify-end gap-2">
      <UiButton type="button" className="btn-ghost px-4 py-2" onClick={() => finish(null)}>Cancel</UiButton>
      <UiButton type="button" className="flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2 font-semibold text-white hover:bg-emerald-600" onClick={() => finish({ muted, camera })}>
        <Icon name="headphones" size={16} />Join huddle</UiButton>
    </div>
  </Dialog>;
}
