'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

export function SettingsTabs({ slug, active }: { slug: string; active: 'general' | 'apps' }) {
  const tab = (on: boolean) => `rounded-lg px-3 py-1.5 text-sm font-medium ${on ? 'bg-brand text-white' : 'text-white/70 hover:bg-brand-soft'}`;
  return <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
    <Link href={`/s/${slug}/settings`} className={tab(active === 'general')} aria-current={active === 'general' ? 'page' : undefined}>General</Link>
    <Link href={`/s/${slug}/settings/apps`} className={tab(active === 'apps')} aria-current={active === 'apps' ? 'page' : undefined}>Apps &amp; workflows</Link>
  </nav>;
}

export function Section({ id, title, intro, children }: { id: string; title: string; intro: ReactNode; children: ReactNode }) {
  return <section id={id} className="card scroll-mt-4 space-y-4 p-5">
    <div><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-white/70">{intro}</p></div>
    {children}
  </section>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn-ghost" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
  }}>{done ? 'Copied' : label}</button>;
}

export function Code({ children, label }: { children: string; label: string }) {
  return <div>
    <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-white/60">{label}</span><CopyButton value={children} /></div>
    <pre className="overflow-x-auto rounded-xl bg-[var(--surface-2)] p-3 text-xs text-white"><code>{children}</code></pre>
  </div>;
}

/** A secret that the server only shows once. */
export function SecretBox({ label, value, note, onClose }: { label: string; value: string; note: string; onClose: () => void }) {
  return <div role="status" className="rounded-xl border border-brand/40 bg-brand-soft p-4">
    <p className="font-semibold">{label}</p>
    <p className="mt-1 text-sm text-white/70">{note}</p>
    <code className="mt-2 block break-all rounded-lg bg-[var(--surface-2)] p-2 text-sm text-white">{value}</code>
    <div className="mt-3 flex gap-2"><CopyButton value={value} /><button type="button" className="btn-ghost" onClick={onClose}>I saved it</button></div>
  </div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-white/15 p-4 text-sm text-white/60">{children}</p>;
}
