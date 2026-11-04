'use client';

import Link from 'next/link';
import { useState } from 'react';
import { conversationTitle, type Conversation } from '../../lib/dms';
import type { Channel, Space } from '../../lib/spaces';

type Props = {
  title?: string;
  channel?: Channel | null;
  space?: Space | null;
  conversation?: Conversation | null;
  onMenu: () => void;
};

/** Top bar of the main area: what is open, plus the ☰ button that opens the sidebar on phones. */
export function ChatHeader({ title, channel, space, conversation, onMenu }: Props) {
  const [showPeople, setShowPeople] = useState(false);
  const menu = <button type="button" onClick={onMenu} aria-label="Open sidebar" className="text-xl text-white/70 md:hidden">☰</button>;

  if (conversation) {
    const online = conversation.participants.filter(person => person.online).length;
    return <header className="relative mb-4 flex items-center gap-3 border-b border-white/10 pb-3">
      {menu}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold">{conversationTitle(conversation)}</h1>
        {!conversation.is_group && <p className="text-xs text-white/50">{conversation.participants[0]?.online ? 'Online' : 'Offline'}</p>}
      </div>
      {conversation.is_group && <button type="button" onClick={() => setShowPeople(value => !value)} aria-expanded={showPeople}
        className="shrink-0 rounded border border-white/15 px-2 py-1 text-xs text-white/70 hover:border-amber-400/60">
        👥 {conversation.participants.length + 1} members · {online} online
      </button>}
      {showPeople && <ul className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-white/15 bg-[#151821] py-1 text-sm shadow-xl">
        <li className="px-3 py-1 text-white/50">You</li>
        {conversation.participants.map(person => <li key={person.id} className="flex items-center gap-2 px-3 py-1">
          <span aria-label={person.online ? 'Online' : 'Offline'} className={`h-2 w-2 rounded-full ${person.online ? 'bg-emerald-400' : 'bg-white/30'}`} />
          {person.username}
        </li>)}
      </ul>}
    </header>;
  }

  if (channel && space) {
    return <header className="mb-4 flex items-start gap-3 border-b border-white/10 pb-3">
      {menu}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold">{channel.type === 'voice' ? '🔊' : '#'} {channel.name}</h1>
        {channel.topic && <p className="truncate text-sm text-white/60">{channel.topic}</p>}
      </div>
      <Link href={`/s/${space.slug}/members`} className="shrink-0 rounded border border-white/15 px-2 py-1 text-xs text-white/70 hover:border-amber-400/60">
        👥 {space.member_count}
      </Link>
    </header>;
  }

  return <header className="mb-4 flex items-center gap-3 border-b border-white/10 pb-3">
    {menu}<h1 className="text-lg font-semibold">{title}</h1>
  </header>;
}
