import { API_URL } from '../../lib/api';

/** Round avatar: the user's picture, or their initial on a colour derived from their name. */
const palette = ['#7c5cff', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#ef4444', '#8b5cf6', '#14b8a6'];

export function colourFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function Avatar({ name, src, size = 32, online, square = false }: {
  name: string; src?: string | null; size?: number; online?: boolean; square?: boolean;
}) {
  const shape = square ? 'rounded-xl' : 'rounded-full';
  return <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
    {src
      ? <img src={src.startsWith('/') ? `${API_URL}${src}` : src} alt="" className={`h-full w-full object-cover ${shape}`} />
      : <span aria-hidden className={`flex h-full w-full items-center justify-center font-semibold text-white ${shape}`}
          style={{ background: colourFor(name), fontSize: size * 0.42, color: '#fff' }}>{name[0]?.toUpperCase()}</span>}
    {online !== undefined && <span aria-label={online ? 'Online' : 'Offline'}
      className={`absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[var(--surface)] ${online ? 'bg-emerald-500' : 'bg-zinc-400'}`}
      style={{ width: Math.max(10, size * 0.3), height: Math.max(10, size * 0.3) }} />}
  </span>;
}
