'use client';

import { Button as UiButton, Input as UiInput, Textarea as UiTextarea, LoadingState } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import type { Post } from '../../lib/posts';
import { apiData, requestError, type Space, type Channel } from '../../lib/spaces';
import type { Conversation } from '../../lib/dms';
import { chatRequest } from '../../lib/socket';

type Props = {
  post: Post;
  isOpen: boolean;
  onClose: () => void;
};

type TargetDestination = {
  id: string; // channel id
  title: string;
  subtitle: string;
  type: 'channel' | 'dm';
};

export function ShareMenu({ post, isOpen, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);

  // Chat picker state
  const [destinations, setDestinations] = useState<TargetDestination[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDestId, setSelectedDestId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatSuccess, setChatSuccess] = useState('');
  const [chatError, setChatError] = useState('');

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      setCanNativeShare(true);
    }
  }, []);

  // Close when clicking outside menu
  useEffect(() => {
    if (!isOpen || chatPickerOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, chatPickerOpen, onClose]);

  // Load spaces channels & DMs for chat picker
  useEffect(() => {
    if (!chatPickerOpen) return;
    setBusy(true);
    setChatError('');
    Promise.all([
      apiData<Space[]>('/api/me/spaces').catch(() => []),
      apiData<Conversation[]>('/api/dms').catch(() => []),
    ])
      .then(async ([spacesList, dmsList]) => {
        const dests: TargetDestination[] = [];

        // Load channels for each space
        for (const sp of spacesList) {
          try {
            const channels = await apiData<Channel[]>(`/api/spaces/${sp.slug}/channels`);
            for (const ch of channels) {
              if (ch.type === 'text') {
                dests.push({
                  id: ch.id,
                  title: `#${ch.name}`,
                  subtitle: sp.name,
                  type: 'channel',
                });
              }
            }
          } catch {
            // ignore
          }
        }

        // Add DMs
        for (const dm of dmsList) {
          const names = dm.participants.map(p => p.username).join(', ');
          dests.push({
            id: dm.id,
            title: `@${names || 'Direct Message'}`,
            subtitle: dm.is_group ? 'Group DM' : 'Direct Message',
            type: 'dm',
          });
        }

        setDestinations(dests);
        if (dests.length > 0) setSelectedDestId(dests[0].id);
      })
      .catch(err => setChatError(requestError(err)))
      .finally(() => setBusy(false));
  }, [chatPickerOpen]);

  if (!isOpen) return null;

  const postUrl = typeof window !== 'undefined' ? `${window.location.origin}/p/${post.id}` : `/p/${post.id}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(postUrl);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onClose();
      }, 1500);
    } catch {
      // fallback
    }
  }

  async function handleNativeShare() {
    try {
      await navigator.share({
        title: post.title,
        url: postUrl,
      });
      onClose();
    } catch {
      // user cancelled or failed
    }
  }

  async function handleSendToChat(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedDestId || busy) return;
    setBusy(true);
    setChatError('');

    const dest = destinations.find(d => d.id === selectedDestId);
    const bodyText = note.trim() ? `${note.trim()}\n${postUrl}` : postUrl;

    try {
      await chatRequest('message:send', {
        channelId: selectedDestId,
        body: bodyText,
        clientMsgId: crypto.randomUUID(),
      });
      setChatSuccess(`Sent to ${dest?.title ?? 'chat'}`);
      setTimeout(() => {
        setChatSuccess('');
        setChatPickerOpen(false);
        onClose();
      }, 1500);
    } catch (cause) {
      setChatError(requestError(cause));
      setBusy(false);
    }
  }

  if (chatPickerOpen) {
    const filtered = destinations.filter(
      d =>
        d.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.subtitle.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send to chat"
        className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.60)] p-4 backdrop-blur-xs"
      >
        <div className="w-full max-w-md rounded-xl border border-white/10 bg-surface p-5 shadow-2xl">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h3 className="font-semibold text-white">↗ Send to chat</h3>
            <UiButton
              onClick={() => {
                setChatPickerOpen(false);
                onClose();
              }}
              className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
            >
              ✕
            </UiButton>
          </div>

          {chatSuccess ? (
            <div className="py-8 text-center text-sm font-medium text-amber-400">
              ✓ {chatSuccess}
            </div>
          ) : (
            <form onSubmit={handleSendToChat} className="mt-4 space-y-4">
              {chatError && (
                <p role="alert" className="text-xs text-rose-400">
                  {chatError}
                </p>
              )}

              <div>
                <UiInput
                  type="text"
                  placeholder="Search channels or DMs…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full rounded border border-white/15 bg-canvas p-2 text-sm text-white placeholder-white/35 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="max-h-48 overflow-y-auto rounded border border-white/10 bg-canvas p-1">
                {busy && destinations.length === 0 ? (
                  <LoadingState layout="inline" label="Loading chats" className="px-3" />
                ) : filtered.length === 0 ? (
                  <p className="p-3 text-center text-xs text-white/40">No conversations found</p>
                ) : (
                  filtered.map(dest => (
                    <UiButton
                      type="button"
                      key={dest.id}
                      onClick={() => setSelectedDestId(dest.id)}
                      className={`flex w-full items-center justify-between rounded px-3 py-2 text-left justify-start text-xs transition-colors ${
                        selectedDestId === dest.id
                          ? 'bg-amber-400/20 text-amber-400'
                          : 'text-white/80 hover:bg-white/5'
                      }`}
                    >
                      <span className="font-medium">{dest.title}</span>
                      <span className="text-white/40">{dest.subtitle}</span>
                    </UiButton>
                  ))
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-white/70">
                  Add a note (optional)
                </label>
                <UiTextarea
                  rows={2}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Write an optional message…"
                  className="mt-1 w-full rounded border border-white/15 bg-canvas p-2 text-sm text-white placeholder-white/30 focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <UiButton
                  type="button"
                  onClick={() => setChatPickerOpen(false)}
                  className="rounded px-3 py-1.5 text-xs text-white/60 hover:text-white"
                >
                  Back
                </UiButton>
                <UiButton
                  type="submit"
                  disabled={busy || !selectedDestId}
                  className="rounded bg-amber-400 px-4 py-1.5 text-xs font-semibold text-black hover:bg-amber-300 disabled:opacity-50"
                >
                  {busy ? 'Sending…' : 'Send'}
                </UiButton>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-lg border border-white/15 bg-surface p-1 shadow-xl text-xs"
    >
      <UiButton
        type="button"
        role="menuitem"
        onClick={handleCopy}
        className="flex w-full items-center gap-2 rounded px-3 py-2 text-left justify-start text-white/80 hover:bg-white/10 hover:text-white"
      >
        <span>🔗</span>
        <span>{copied ? 'Copied link!' : 'Copy link'}</span>
      </UiButton>

      {canNativeShare && (
        <UiButton
          type="button"
          role="menuitem"
          onClick={handleNativeShare}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left justify-start text-white/80 hover:bg-white/10 hover:text-white"
        >
          <span>↗</span>
          <span>Share…</span>
        </UiButton>
      )}

      <UiButton
        type="button"
        role="menuitem"
        onClick={() => setChatPickerOpen(true)}
        className="flex w-full items-center gap-2 rounded px-3 py-2 text-left justify-start text-white/80 hover:bg-white/10 hover:text-white"
      >
        <span>💬</span>
        <span>Send to chat…</span>
      </UiButton>
    </div>
  );
}
