'use client';

import { Button as UiButton } from '@hive/ui';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@hive/shared';
import { chatRequest } from '../lib/socket';
import { requestError } from '../lib/spaces';

export function PollCard({ message, userId }: { message: Message; userId?: string }) {
  const poll = message.poll;
  const [vote, setVote] = useState<string[]>(poll?.myVotes?.length ? poll.myVotes : poll?.myVote ? [poll.myVote] : []);
  const [closed, setClosed] = useState(poll?.closedAt ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => setVote(poll?.myVotes?.length ? poll.myVotes : poll?.myVote ? [poll.myVote] : []), [poll?.myVotes,poll?.myVote,userId,message.id]);
  useEffect(() => setClosed(poll?.closedAt ?? null), [poll?.closedAt]);
  if (!poll) return null;
  const currentPoll = poll;
  async function choose(optionId: string) {
    if (busy || !userId || closed) return;
    setBusy(true); setError('');
    const next = currentPoll.multipleAnswers ? (vote.includes(optionId) ? vote.filter(id => id !== optionId) : [...vote, optionId]) : (vote[0] === optionId ? [] : [optionId]);
    try { const data=await chatRequest<{poll:NonNullable<Message['poll']>}>('poll:vote',currentPoll.multipleAnswers?{messageId:message.id,optionIds:next}:{messageId:message.id,optionId:next[0]??null});setVote(data.poll.myVotes?.length ? data.poll.myVotes : data.poll.myVote ? [data.poll.myVote] : []); }
    catch(cause){setError(requestError(cause));}finally{setBusy(false);}
  }
  return <section className="my-2 max-w-lg rounded-xl border border-white/10 bg-canvas p-4" aria-label="Poll"><h3 className="mb-1 font-semibold">{poll.question}</h3><p className="mb-3 text-xs text-white/60">{poll.multipleAnswers?'Select all that apply':'Select one answer'}</p>
    <div ref={group} role={poll.multipleAnswers?'group':'radiogroup'} aria-label={poll.question} className="space-y-2" onKeyDown={event=>{
      if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const buttons=Array.from(group.current?.querySelectorAll<HTMLButtonElement>('[role=radio], [role=checkbox]')??[]);const index=buttons.indexOf(document.activeElement as HTMLButtonElement);const next=(index+(event.key==='ArrowDown'||event.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[next]?.focus();
    }}>{poll.options.map((option,index)=>{const count=poll.counts[option.id]??option.count??0;const percent=poll.total?Math.round(count*100/poll.total):0;const selected=vote.includes(option.id);return <UiButton tooltip={`${option.label}, ${count} votes, ${percent}%`} key={option.id} type="button" role={poll.multipleAnswers?'checkbox':'radio'} aria-checked={selected} aria-label={`${option.label}, ${count} votes, ${percent}%`} disabled={busy||!userId||!!closed} className={`relative flex min-h-11 w-full overflow-hidden rounded-lg border px-3 py-2 text-left justify-start text-sm ${selected?'border-brand':'border-white/15'} disabled:cursor-default`} onClick={()=>void choose(option.id)}><span aria-hidden className="absolute inset-y-0 left-0 bg-brand/15 transition-[width]" style={{width:`${percent}%`}}/><span className={`relative mr-2 flex h-4 w-4 shrink-0 items-center justify-center border ${poll.multipleAnswers?'rounded':'rounded-full'} ${selected?'border-brand bg-brand text-white':'border-white/40'}`}>{selected&&'✓'}</span><span className="relative flex-1 break-words">{option.label}</span><span className="relative ml-2 shrink-0 text-xs text-white/70">{count} · {percent}%</span></UiButton>;})}</div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-white/65"><span>{poll.total} votes · {closed?'Closed':poll.multipleAnswers?'multiple answers allowed':'select again to retract'}</span>{userId===message.author.id&&!closed&&<UiButton type="button" className="text-brand underline" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{const data=await chatRequest<{poll:NonNullable<Message['poll']>}>('poll:close',{messageId:message.id});setClosed(data.poll.closedAt);}catch(cause){setError(requestError(cause));}finally{setBusy(false);}}}>Close poll</UiButton>}</div>
    {error&&<p role="alert" className="mt-2 text-sm text-rose-500">{error}</p>}
  </section>;
}
