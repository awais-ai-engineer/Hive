'use client';

import { useEffect, useRef } from 'react';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icons';

type Props = {
  stream: MediaStream | null;
  name: string;
  avatarUrl?: string | null;
  muted: boolean;
  speaking: boolean;
  video: boolean;
  self?: boolean;
  large?: boolean;
};

/** One participant: their video (or avatar when the camera is off), name, mic and speaking state. */
export function VideoTile({ stream, name, avatarUrl, muted, speaking, video, self = false, large = false }: Props) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  const talking = speaking && !muted;
  return <figure aria-label={`${name}${self ? ' (you)' : ''}${muted ? ', muted' : talking ? ', speaking' : ''}`}
    className={`relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--surface-2)] ${large ? 'col-span-full' : ''} ${talking ? 'ring-2 ring-emerald-500' : 'ring-1 ring-white/10'}`}>
    {/* Sound plays from the call dock so it continues while tiles are closed; tiles stay silent. */}
    <video ref={element} autoPlay playsInline muted className={`h-full w-full object-contain ${video ? '' : 'hidden'}`} />
    {!video && <Avatar name={name} src={avatarUrl} size={large ? 72 : 48} />}
    <figcaption className="absolute bottom-1.5 left-1.5 flex max-w-[90%] items-center gap-1 rounded-md bg-[rgb(0_0_0/0.6)] px-1.5 py-0.5 text-xs" style={{ color: 'var(--rail-fg)' }}>
      {muted && <Icon name="micOff" size={12} aria-label="Muted" />}<span className="truncate">{name}{self && ' (you)'}</span>
    </figcaption>
  </figure>;
}
