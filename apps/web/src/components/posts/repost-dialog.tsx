'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiData, requestError, type Space } from '../../lib/spaces';
import { repost, type Post } from '../../lib/posts';

type Props = {
  post: Post;
  isOpen: boolean;
  onClose: () => void;
};

export function RepostDialog({ post, isOpen, onClose }: Props) {
  const router = useRouter();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    apiData<Space[]>('/api/me/spaces')
      .then(list => {
        // Only spaces where user is member or higher, excluding the post's space
        const valid = list.filter(
          s =>
            s.id !== post.space.id &&
            s.my_role &&
            ['owner', 'admin', 'moderator', 'member'].includes(s.my_role)
        );
        setSpaces(valid);
        if (valid.length > 0) {
          setSelectedSlug(valid[0].slug);
        }
      })
      .catch(err => setError(requestError(err)));
  }, [isOpen, post.space.id]);

  if (!isOpen) return null;

  async function handleRepost(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedSlug || busy) return;
    setBusy(true);
    setError('');
    try {
      const newPost = await repost(post.id, selectedSlug, title);
      onClose();
      router.push(`/p/${newPost.id}`);
    } catch (cause) {
      setError(requestError(cause));
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Repost to a space"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.60)] p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-surface p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <h3 className="font-semibold text-white">🔁 Repost to a space</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-rose-400">
            {error}
          </p>
        )}

        {spaces.length === 0 ? (
          <div className="py-6 text-center text-sm text-white/50">
            You don&apos;t have any other spaces where you can repost.
          </div>
        ) : (
          <form onSubmit={handleRepost} className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-white/70">
                Target Space
              </label>
              <select
                value={selectedSlug}
                onChange={e => setSelectedSlug(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-canvas p-2 text-sm text-white focus:border-amber-400 focus:outline-none"
              >
                {spaces.map(s => (
                  <option key={s.id} value={s.slug}>
                    {s.name} ({s.slug})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-white/70">
                Title (optional)
              </label>
              <input
                type="text"
                maxLength={300}
                placeholder={post.title}
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="mt-1 w-full rounded border border-white/15 bg-canvas p-2 text-sm text-white placeholder-white/30 focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={onClose}
                className="rounded px-3 py-1.5 text-xs text-white/60 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-amber-400 px-4 py-1.5 text-xs font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
              >
                {busy ? 'Reposting…' : 'Repost'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
