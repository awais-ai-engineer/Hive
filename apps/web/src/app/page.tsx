'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { Icon, Logo, type IconName } from '../components/ui/icons';

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'message', title: 'Channels, threads and DMs', text: 'Real-time chat with formatting, mentions, reactions, polls, reminders and scheduled messages.' },
  { icon: 'headphones', title: 'Huddles', text: 'One click voice and video calls with screen sharing, live captions and meeting notes saved for the team.' },
  { icon: 'layers', title: 'Community posts', text: 'Reddit-style feeds with votes, nested comments and Hot, New and Top ranking.' },
  { icon: 'checkSquare', title: 'Docs and tasks', text: 'Notes and checklists next to the chat, and a board that turns any message into a task.' },
  { icon: 'search', title: 'Search everything', text: 'Find messages, files, posts and people across every space you belong to.' },
  { icon: 'sparkles', title: 'AI that respects access', text: 'Catch up on what you missed and ask questions about your own spaces, with sources.' },
];

const PRIVACY = [
  'Private workspaces are invisible to everyone you have not invited.',
  'Private channels and direct messages are only readable by the people in them.',
  'Secret conversations are end-to-end encrypted on your devices.',
  'Your email is never shown. You can block, report and appear offline any time.',
];

/** Public landing page. Signed-in people go straight to the app. */
export default function Landing() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => { if (!loading && user) router.replace('/home'); }, [loading, user, router]);
  if (loading || user) return <main className="min-h-[60vh]" />;

  return <main>
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-14 md:grid-cols-[1.1fr_1fr] md:pt-20">
      <div>
        <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-brand-soft px-3 py-1 text-sm font-semibold text-[var(--brand-soft-fg)]">
          <Icon name="sparkles" size={14} />Chat, communities and calls in one place</p>
        <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl">Your team’s chat, your community’s forum, and your calls.</h1>
        <p className="mt-4 max-w-xl text-lg text-white/65">Hive brings private team workspaces and public communities together, with huddles, docs, tasks and search built in.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link href="/signup" className="auth-button !w-auto px-6">Get started free</Link>
          <Link href="/login" className="btn-ghost px-6 py-3 text-base">Log in</Link>
        </div>
        <p className="mt-3 text-sm text-white/50">Free to use. No credit card.</p>
      </div>
      <div aria-hidden className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-pop)]">
        <div className="flex h-72">
          <div className="flex w-14 flex-col items-center gap-3 bg-[var(--rail)] py-3">
            <Logo size={24} />
            {['#f2a516', '#0ea5e9', '#10b981'].map(color => <span key={color} className="h-8 w-8 rounded-lg" style={{ background: color }} />)}
          </div>
          <div className="w-40 space-y-2 border-r border-[var(--border)] bg-[var(--sidebar)] p-3 text-xs">
            <p className="font-bold">Northwind</p>
            {['general', 'product', 'design', 'releases'].map((name, index) => <p key={name} className={`rounded px-2 py-1 ${index === 1 ? 'bg-[var(--sidebar-active)] font-semibold' : 'text-white/60'}`}># {name}</p>)}
          </div>
          <div className="flex-1 space-y-3 p-4 text-xs">
            <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 font-semibold"><span className="h-2 w-2 rounded-full bg-emerald-500" />Sprint sync huddle is live</p>
            {[['Ayesha', 'The onboarding spec is ready for review.'], ['Bilal', '@Hamza can you confirm the invite API?'], ['Release bot', 'v2.8 is live in production.']].map(([who, text]) =>
              <div key={who} className="flex gap-2"><span className="h-7 w-7 shrink-0 rounded-full bg-brand-soft" /><div><p className="font-semibold">{who}</p><p className="text-white/65">{text}</p></div></div>)}
          </div>
        </div>
      </div>
    </section>

    <section className="mx-auto max-w-6xl px-4 pb-16">
      <h2 className="mb-6 text-center text-2xl font-bold">Two ways to use Hive</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-6"><p className="text-2xl">🔒</p><h3 className="mt-2 text-lg font-bold">Private workspaces</h3>
          <p className="mt-1 text-white/65">For teams and companies. Invite-only, with private channels, huddles, docs and tasks. Nobody outside can see anything.</p></div>
        <div className="card p-6"><p className="text-2xl">🌐</p><h3 className="mt-2 text-lg font-bold">Public communities</h3>
          <p className="mt-1 text-white/65">For open groups. Anyone can discover posts and discussions; members join the chat rooms, games and events.</p></div>
      </div>
    </section>

    <section className="bg-[var(--surface-2)] py-16">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="mb-8 text-center text-2xl font-bold">Everything a team or community needs</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(feature => <div key={feature.title} className="card p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-[var(--brand-soft-fg)]"><Icon name={feature.icon} size={20} /></span>
            <h3 className="mt-3 font-bold">{feature.title}</h3>
            <p className="mt-1 text-sm text-white/65">{feature.text}</p>
          </div>)}
        </div>
      </div>
    </section>

    <section className="mx-auto max-w-4xl px-4 py-16">
      <h2 className="text-center text-2xl font-bold">Privacy built in</h2>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {PRIVACY.map(line => <li key={line} className="flex gap-3 rounded-xl border border-[var(--border)] p-4 text-sm">
          <Icon name="lock" size={16} className="mt-0.5 shrink-0 text-[var(--brand)]" />{line}</li>)}
      </ul>
      <div className="mt-12 rounded-2xl bg-[#15171c] p-8 text-center dark:bg-[var(--surface-2)]">
        <h2 className="text-2xl font-bold" style={{ color: '#fff' }}>Bring your people together</h2>
        <p className="mt-2" style={{ color: 'rgb(255 255 255 / 0.7)' }}>Create a workspace for your team or join a community in under a minute.</p>
        <Link href="/signup" className="auth-button mx-auto mt-5 !w-auto px-8">Create your account</Link>
      </div>
    </section>

    <footer className="border-t border-[var(--border)] py-8 text-sm text-white/55">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4">
        <span className="flex items-center gap-2 font-semibold text-white/80"><Logo size={18} />Hive</span>
        <Link href="/spaces" className="hover:underline">Explore communities</Link>
        <Link href="/policies" className="hover:underline">Help & policies</Link>
        <Link href="/status" className="hover:underline">Service status</Link>
        <span className="ml-auto">© {new Date().getFullYear()} Hive</span>
      </div>
    </footer>
  </main>;
}
