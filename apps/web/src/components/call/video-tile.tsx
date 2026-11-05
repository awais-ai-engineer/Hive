'use client';

import { useEffect, useRef } from 'react';

type Props = {
  stream: MediaStream | null;
  name: string;
  muted: boolean;
  speaking: boolean;
  video: boolean;
  self?: boolean;
  large?: boolean;
};

/** One participant: their video (or initial when the camera is off), name, mic and speaking state. */
export function VideoTile({ stream, name, muted, speaking, video, self = false, large = false }: Props) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  return <figure className={`relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black/60 aspect-video ${large ? 'col-span-full' : ''} ${speaking && !muted ? 'ring-2 ring-emerald-400' : 'ring-1 ring-white/10'}`}>
    {/* Self view stays muted so you never hear your own echo. */}
    <video ref={element} autoPlay playsInline muted={self} className={`h-full w-full object-contain ${video ? '' : 'hidden'}`} />
    {!video && <span aria-hidden className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-400/15 text-2xl font-semibold text-amber-400">{name[0]?.toUpperCase()}</span>}
    <figcaption className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-xs">
      {muted && <span aria-label="Muted">🔇</span>}{name}{self && ' (you)'}
    </figcaption>
  </figure>;
}
