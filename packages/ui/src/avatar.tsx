'use client';

import { forwardRef, useState, type HTMLAttributes } from 'react';

const palette = ['var(--avatar-lilac)', 'var(--avatar-pink)', 'var(--avatar-sand)', 'var(--avatar-mint)', 'var(--avatar-blue)'];

/** A stable pastel for a name or space identifier. */
export function colourFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : name.trim().slice(0, 2)).toUpperCase() || '?';
}

export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  name: string;
  src?: string | null;
  size?: number;
  online?: boolean;
  status?: 'active' | 'away' | 'offline';
  statusBorder?: string;
};

/** Rounded-square avatar; every size uses the same 27% corner radius. */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar({ name, src, size = 32, online, status, statusBorder = 'var(--surface)', className = '', style, ...props }, ref) {
  const [failed, setFailed] = useState<string | null>(null);
  const presence = status ?? (online === undefined ? undefined : online ? 'active' : 'offline');
  const radius = size * 0.27;
  return <span ref={ref} role="img" aria-label={name} className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size, ...style }} {...props}>
    {src && failed !== src
      ? <img src={src} alt="" onError={() => setFailed(src)} style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }} />
      : <span aria-hidden className="hive-initials" data-initials={initials(name)} style={{ width: size, height: size, borderRadius: radius, background: colourFor(name), color: 'var(--avatar-fg)', fontSize: size * 0.37, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }} />}
    {presence && <><span aria-hidden style={{ position: 'absolute', bottom: -1, right: -1, width: size >= 44 ? 12 : Math.max(8, size * 0.28), height: size >= 44 ? 12 : Math.max(8, size * 0.28), borderRadius: '50%', border: `2px solid ${statusBorder}`, background: `var(--status-${presence})` }} /><span className="sr-only">{presence}</span></>}
  </span>;
});
