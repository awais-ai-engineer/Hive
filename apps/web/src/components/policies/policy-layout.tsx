import Link from 'next/link';
import type { ReactNode } from 'react';

export const policyLinks = [
  ['guidelines', 'Community Guidelines'], ['content', 'Content Policy'],
  ['privacy', 'Privacy Policy'], ['terms', 'Terms of Service'],
] as const;
export function PolicyLinks() {
  return <nav aria-label="Hive policies" className="flex flex-wrap gap-x-5 gap-y-3 text-sm">{policyLinks.map(([slug, title]) => <Link key={slug} href={`/policies/${slug}`} className="text-brand underline">{title}</Link>)}</nav>;
}
export type PolicySection = { id: string; title: string; text: string[] };
export function PolicyLayout({ title, sections, children }: { title: string; sections: PolicySection[]; children?: ReactNode }) {
  return <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
    <Link href="/policies" className="text-sm font-medium text-brand underline">Help & policies</Link>
    <h1 className="text-3xl font-extrabold">{title}</h1><p className="text-sm text-white/65">Last updated: <time dateTime="2026-11-06">6 November 2026</time></p>
    <p className="rounded-xl border border-brand/30 bg-brand-soft p-4 text-sm">This text is a template and must be reviewed by a legal professional before launch.</p>
    {sections.length > 0 && <nav aria-label="Table of contents" className="card p-5"><h2 className="mb-3 font-bold">On this page</h2><ol className="list-inside list-decimal space-y-2">{sections.map(section => <li key={section.id}><a className="text-brand underline" href={`#${section.id}`}>{section.title}</a></li>)}</ol></nav>}
    {children}
    <article className="space-y-8">{sections.map(section => <section key={section.id} id={section.id} className="scroll-mt-24"><h2 className="mb-3 text-xl font-bold">{section.title}</h2>{section.text.map((text, index) => <p key={index} className="mb-3 leading-relaxed text-white/80">{text}</p>)}</section>)}</article>
    <footer className="border-t border-white/10 pt-6"><PolicyLinks /></footer>
  </main>;
}
