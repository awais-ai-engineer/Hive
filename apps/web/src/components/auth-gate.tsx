'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';

const PUBLIC = ['/', '/login', '/signup', '/guide', '/status', '/policies'];
const isPublic = (path: string) => PUBLIC.some(item => path === item || (item !== '/' && path.startsWith(`${item}/`)));

/** Everything except the sign-in pages needs an account; signed-in people skip the sign-in pages. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const path = usePathname() ?? '/';
  const open = isPublic(path) || (process.env.NODE_ENV === 'development' && path === '/components');
  const entry = path === '/' || path === '/login' || path === '/signup';
  useEffect(() => {
    if (loading) return;
    if (!user && !open) router.replace(`/login?next=${encodeURIComponent(path + window.location.search)}`);
    else if (user && entry) router.replace('/home');
  }, [loading, user, open, entry, path, router]);
  if (!open && (loading || !user)) return <main className="min-h-[60vh]" />;
  return <>{children}</>;
}
