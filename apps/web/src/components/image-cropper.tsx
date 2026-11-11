'use client';

import { Slider as UiSlider, Button as UiButton } from '@hive/ui';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui/icons';

type Shape = 'avatar' | 'cover';
const OUTPUT = { avatar: { width: 512, height: 512 }, cover: { width: 1600, height: 500 } } as const;
const MAX_ZOOM = 4;

/**
 * Crop, zoom and rotate a picture without any library. Drag (or use the arrow keys) to move,
 * slider / wheel / pinch / +/- to zoom, R to rotate. Saves exactly 512x512 (avatar) or 1600x500 (cover).
 */
export function ImageCropper({ file, shape, onCancel, onSave }: {
  file: File; shape: Shape; onCancel: () => void; onSave: (image: File) => Promise<void> | void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [turns, setTurns] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);

  const frame = shape === 'avatar' ? { width: 280, height: 280 } : { width: 400, height: 125 };

  useEffect(() => {
    let live = true;
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then(image => { if (live) setBitmap(image); else image.close(); })
      .catch(() => { if (live) setError('That file could not be read as a picture.'); });
    return () => { live = false; };
  }, [file]);
  useEffect(() => () => bitmap?.close(), [bitmap]);

  const geometry = useCallback((nextTurns: number, nextZoom: number) => {
    if (!bitmap) return null;
    const sideways = nextTurns % 2 !== 0;
    const width = sideways ? bitmap.height : bitmap.width;
    const height = sideways ? bitmap.width : bitmap.height;
    const scale = Math.max(frame.width / width, frame.height / height) * nextZoom;
    return { scale, limitX: Math.max(0, (width * scale - frame.width) / 2), limitY: Math.max(0, (height * scale - frame.height) / 2) };
  }, [bitmap, frame.width, frame.height]);

  const clamp = useCallback((point: { x: number; y: number }, nextTurns = turns, nextZoom = zoom) => {
    const g = geometry(nextTurns, nextZoom);
    if (!g) return point;
    return { x: Math.min(g.limitX, Math.max(-g.limitX, point.x)), y: Math.min(g.limitY, Math.max(-g.limitY, point.y)) };
  }, [geometry, turns, zoom]);

  const paint = useCallback((target: HTMLCanvasElement, width: number, height: number, preview: boolean) => {
    const context = target.getContext('2d');
    const g = geometry(turns, zoom);
    if (!context || !bitmap || !g) return;
    const ratio = width / frame.width;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2 + offset.x * ratio, height / 2 + offset.y * ratio);
    context.rotate((turns * Math.PI) / 2);
    context.scale(g.scale * ratio, g.scale * ratio);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    context.restore();
    if (preview && shape === 'avatar') {
      context.save();
      context.fillStyle = 'rgba(0,0,0,0.55)';
      context.beginPath();
      context.rect(0, 0, width, height);
      context.arc(width / 2, height / 2, width / 2 - 2, 0, Math.PI * 2, true);
      context.fill('evenodd');
      context.strokeStyle = 'var(--rail-fg)';
      context.lineWidth = 2;
      context.beginPath();
      context.arc(width / 2, height / 2, width / 2 - 2, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }, [bitmap, geometry, offset, turns, zoom, shape, frame.width]);

  useEffect(() => { if (canvas.current) paint(canvas.current, frame.width, frame.height, true); }, [paint, frame.width, frame.height]);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    canvas.current?.focus();
    return () => before?.focus?.();
  }, []);

  function changeZoom(next: number) {
    const value = Math.min(MAX_ZOOM, Math.max(1, next));
    setZoom(value);
    setOffset(current => clamp(current, turns, value));
  }
  function rotate(step: number) {
    const next = (turns + step + 4) % 4;
    setTurns(next);
    setOffset(current => clamp(current, next, zoom));
  }

  function down(event: React.PointerEvent) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinch.current = 0;
  }
  function move(event: React.PointerEvent) {
    const known = pointers.current.get(event.pointerId);
    if (!known) return;
    const next = { x: event.clientX, y: event.clientY };
    if (pointers.current.size === 2) {
      pointers.current.set(event.pointerId, next);
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current) changeZoom(zoom * (distance / pinch.current));
      pinch.current = distance;
      return;
    }
    pointers.current.set(event.pointerId, next);
    setOffset(current => clamp({ x: current.x + next.x - known.x, y: current.y + next.y - known.y }));
  }
  function up(event: React.PointerEvent) { pointers.current.delete(event.pointerId); pinch.current = 0; }

  function key(event: React.KeyboardEvent) {
    const step = 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) { event.preventDefault(); setOffset(current => clamp({ x: current.x + moves[event.key][0], y: current.y + moves[event.key][1] })); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(zoom + 0.2); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); changeZoom(zoom - 0.2); }
    else if (event.key.toLowerCase() === 'r') { event.preventDefault(); rotate(event.shiftKey ? -1 : 1); }
  }
  // Wheel zoom needs a non-passive listener so the page does not scroll with it.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key === 'Tab') {
        const items = Array.from(box.current?.querySelectorAll<HTMLElement>('canvas, button, input') ?? []).filter(item => !item.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  async function save() {
    const out = document.createElement('canvas');
    const { width, height } = OUTPUT[shape];
    out.width = width; out.height = height;
    paint(out, width, height, false);
    setSaving(true); setError('');
    try {
      const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/webp', 0.9));
      const result = blob && blob.type === 'image/webp' ? blob : await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/jpeg', 0.9));
      if (!result) throw new Error('Could not prepare the picture.');
      const extension = result.type === 'image/webp' ? 'webp' : 'jpg';
      await onSave(new File([result], `${shape}.${extension}`, { type: result.type }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the picture.'); }
    finally { setSaving(false); }
  }

  const label = shape === 'avatar' ? 'profile photo' : 'cover image';
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.55)] p-3">
    <div ref={box} role="dialog" aria-modal="true" aria-label={`Adjust your ${label}`} className="card w-full max-w-md space-y-4 p-5">
      <h2 className="text-lg font-bold">Adjust your {label}</h2>
      <div className="flex justify-center">
        <canvas ref={canvas} width={frame.width} height={frame.height} tabIndex={0} role="img"
          aria-label="Drag to move the picture. Arrow keys move, plus and minus zoom, R rotates."
          style={{ width: frame.width, height: frame.height, maxWidth: '100%', touchAction: 'none' }}
          className="cursor-grab rounded-xl bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)] active:cursor-grabbing"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} />
      </div>
      {!bitmap && !error && <p role="status" className="text-center text-sm text-white/60">Loading picture…</p>}
      <div className="flex items-center gap-3">
        <label htmlFor="crop-zoom" className="text-sm font-medium">Zoom</label>
        <UiSlider id="crop-zoom" min={1} max={MAX_ZOOM} step={0.01} value={zoom} disabled={!bitmap}
          className="flex-1 accent-[var(--brand)]" onChange={event => changeZoom(Number(event.target.value))} />
        <UiButton type="button" className="btn-ghost !px-2" aria-label="Rotate left" tooltip="Rotate left" disabled={!bitmap} onClick={() => rotate(-1)}><Icon name="rotateLeft" size={18} /></UiButton>
        <UiButton type="button" className="btn-ghost !px-2" aria-label="Rotate right" tooltip="Rotate right (R)" disabled={!bitmap} onClick={() => rotate(1)}><Icon name="rotateRight" size={18} /></UiButton>
      </div>
      {error && <p role="alert" className="text-sm text-rose-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <UiButton type="button" className="btn-ghost" onClick={onCancel} disabled={saving}>Cancel</UiButton>
        <UiButton type="button" className="auth-button" onClick={() => void save()} disabled={!bitmap || saving}>{saving ? 'Saving…' : 'Save'}</UiButton>
      </div>
    </div>
  </div>;
}
