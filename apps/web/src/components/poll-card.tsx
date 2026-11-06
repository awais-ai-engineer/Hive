'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@hive/shared';
import { chatRequest } from '../lib/socket';
import { requestError } from '../lib/spaces';

export function PollCard({ message, userId }: { message: Message; userId?: string }) {
  const poll = message.poll;
  const [vote, setVote] = useState(poll?.myVote ?? null);
  const [closed, setClosed] = useState(poll?.closedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => setVote(poll?.myVote ?? null), [poll?.myVote,userId,message.id]);
  useEffect(() => setClosed(poll?.closedAt ?? null), [poll?.closedAt]);
  if (!poll) return null;
  async function choose(optionId: string) {
    if (busy || !userId || closed) return;
    setBusy(true); setError('');
    try { const data=await chatRequest<{poll:NonNullable<Message['poll']>}>('poll:vote',{messageId:message.id,optionId:vote===optionId?null:optionId});setVote(data.poll.myVote); }
    catch(cause){setError(requestError(cause));}finally{setBusy(false);}
  }
  return <section className="my-2 max-w-lg rounded-xl border border-white/10 bg-canvas p-4" aria-label="Poll"><h3 className="mb-3 font-semibold">{poll.question}</h3>
    <div ref={group} role="radiogroup" aria-label={poll.question} className="space-y-2" onKeyDown={event=>{
      if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const buttons=Array.from(group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=(index+(event.key==='ArrowDown'||event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[next]?.focus();
    }}>{poll.options.map((option,index)=>{const count=poll.counts[option.id]??option.count??0;const percent=poll.total?Math.round(count*100/poll.total):0;return <button key={option.id} type="button" role="radio" aria-checked={vote===option.id} aria-label={`${option.label}, ${count} votes, ${percent}%`} disabled={busy||!userId||!!closed} className={`relative flex min-h-11 w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm ${vote===option.id?'border-brand':'border-white/15'} disabled:cursor-default`} onClick={()=>void choose(option.id)}><span aria-hidden className="absolute inset-y-0 left-0 bg-brand/15 transition-[width]" style={{width:`${percent}%`}}/><span className="relative flex-1 break-words">{option.label}</span><span className="relative ml-2 shrink-0 text-xs text-white/70">{count} · {percent}%</span></button>;})}</div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/65"><span>{poll.total} votes · {closed?'Closed':'Anonymous · select again to retract'}</span>{userId===message.author.id&&!closed&&<button type="button" className="text-brand underline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const data=await chatRequest<{poll:NonNullable<Message['poll']>}>('poll:close',{messageId:message.id});setClosed(data.poll.closedAt);}catch(cause){setError(requestError(cause));}finally{setBusy(false);}}}>Close poll</button>}</div>
    {error&&<p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
  </section>;
}
