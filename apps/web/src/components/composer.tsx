'use client';

import { useEffect, useRef, useState } from 'react';
import { parseWhen, safeLinkUrl, type Attachment } from '@hive/shared';
import { UploadPicker, type UploadControls } from './upload-picker';
import { EmojiPicker } from './emoji-picker';
import { highlight } from './composer-highlight';
import { VoiceRecorder } from './voice-recorder';
import { RewriteButton } from './ai/rewrite';
import { Icon } from './ui/icons';
import { socket } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { apiData, requestError } from '../lib/spaces';
import { apiFetch, responseData } from '../lib/api';
import { DRAFTS_CHANGED, saveComposerDraft, type SavedDraft } from '../lib/composer-drafts';
import { emojiData } from '../lib/emoji-data';
import { formats, formatSelection, pollCommand, type ComposerSendOptions, type FormatAction } from '../lib/composer-actions';

type Props = { channelId: string; parentId?: string | null; channels?: { id: string; name: string }[]; placeholder: string; reason: string; sendTyping?: boolean; secret?: boolean; allowViewOnce?: boolean; onEditLast?: () => void; onSend: (body: string, files: Attachment[], options?: ComposerSendOptions) => Promise<boolean | void> | boolean | void };
type Candidate = { userId: string; username: string; displayName?: string | null };
type CustomCommand = { id: string; name: string; description: string; usage: string; botName: string };
const commands = [
  { name: 'poll', usage: '/poll "Question" "A" "B"', description: 'Ask a question with 2–10 answers' },
  { name: 'remind', usage: '/remind in 30m text', description: 'Set a personal reminder' },
  { name: 'status', usage: '/status :coffee: Focusing', description: 'Update your profile status' },
  { name: 'shrug', usage: '/shrug ', description: 'Add a shrug to your message' },
];

export function Composer({ channelId, parentId = null, channels = [], placeholder, reason, sendTyping = false, secret = false, allowViewOnce = false, onSend, onEditLast }: Props) {
  const { user, updateUser } = useAuth();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<'emoji' | 'more' | 'help' | 'link' | 'later' | null>(null);
  const [url, setUrl] = useState('');
  const [viewOnce, setViewOnce] = useState(false);
  const [when, setWhen] = useState('');
  const [caret, setCaret] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const [custom, setCustom] = useState<CustomCommand[]>([]);
  const uploads = useRef<UploadControls | null>(null);
  // Mentions read as "@name" while typing; they become stable id tokens only when sent.
  const picked = useRef(new Map<string, string>());
  const mirror = useRef<HTMLDivElement>(null);
  const encode = (text: string) => text.replace(/[@#][\w-]+/g, word => picked.current.get(word) ?? word);
  const box = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const bodyRef = useRef(body); bodyRef.current = body;
  const loaded = useRef(false);
  const saved = useRef('');
  const lastTyping = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const owner = user?.id;
  useEffect(() => {
    let active = true; setCustom([]);
    if (!owner || reason) return;
    apiData<CustomCommand[]>(`/api/channels/${channelId}/commands`).then(list => { if (active) setCustom(list); }).catch(() => {});
    return () => { active = false; };
  }, [owner, channelId, reason]);
  useEffect(() => {
    let active = true; loaded.current = false; setReady(false); setBody(''); saved.current = '';
    if (!owner || reason || secret) { setReady(true); return; }
    apiData<SavedDraft | null>(`/api/channels/${channelId}/draft${parentId ? `?parentId=${parentId}` : ''}`).then(draft => {
      if (active) { saved.current = draft?.body ?? ''; setBody(saved.current); setCaret(saved.current.length); loaded.current = true; setReady(true); }
    }).catch(cause => { if (active) { setError(`Draft could not be restored: ${requestError(cause)}`); loaded.current = true; setReady(true); } });
    return () => { active = false; if (loaded.current && bodyRef.current !== saved.current) void saveComposerDraft(owner, channelId, parentId, bodyRef.current).catch(() => {}); };
  }, [owner, channelId, parentId, reason, secret]);
  useEffect(() => {
    if (!loaded.current || !owner || reason || body === saved.current) return;
    const timer = setTimeout(() => { saved.current = body; void saveComposerDraft(owner, channelId, parentId, body).catch(() => setError('Could not save your draft. Keep this page open and retry.')); }, 800);
    return () => clearTimeout(timer);
  }, [body, owner, channelId, parentId, reason, ready]);
  function stopTyping() { if (idle.current) clearTimeout(idle.current); idle.current = null; if (sendTyping && lastTyping.current && socket.connected) socket.emit('typing:stop', { channelId }); lastTyping.current = 0; }
  useEffect(() => stopTyping, [channelId]);
  function change(value: string, nextCaret = value.length) {
    setBody(value); setCaret(nextCaret); setNotice(''); setDismissed('');
    if (!sendTyping) return;
    if (socket.connected && Date.now()-lastTyping.current >= 3000) { socket.emit('typing:start', { channelId }); lastTyping.current = Date.now(); }
    if (idle.current) clearTimeout(idle.current); idle.current = setTimeout(stopTyping, 4000);
  }
  function selectRange(value: string, start: number, end = start) {
    if (value.length > 4000) { setError('Messages can be at most 4000 characters.'); return; }
    change(value,end); selection.current = { start, end };
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(start,end); });
  }
  function insert(value: string) { const { start, end } = selection.current; selectRange(body.slice(0,start)+value+body.slice(end),start+value.length); }
  function format(action: FormatAction) { const { start,end } = selection.current; const result = formatSelection(body,start,end,action); selectRange(result.value,result.start,result.end); }
  function clear(sent?: string) { stopTyping(); if (sent !== undefined && bodyRef.current !== sent) { setFiles([]); setPickerKey(value => value+1); return; } bodyRef.current = ''; saved.current = ''; setBody(''); setCaret(0); selection.current = { start:0,end:0 }; setFiles([]); setViewOnce(false); setPickerKey(value => value+1); if (owner && !secret) void saveComposerDraft(owner,channelId,parentId,'').catch(() => setError('Message sent, but the saved draft could not be cleared.')); window.dispatchEvent(new Event(DRAFTS_CHANGED)); }
  const token = secret ? null : /(?:^|[\s(])([@#])([\w-]*)$/.exec(body.slice(0,caret));
  const tokenKind = token?.[1], tokenQuery = token?.[2] ?? '';
  const tokenKey = `${body}:${caret}`;
  const slash = secret ? null : /^\/([a-z]*)$/i.exec(body);
  const allCommands = [...commands, ...custom.map(item => ({ name: item.name, usage: item.usage, description: `${item.description || 'Custom command'} · ${item.botName}` }))];
  const commandChoices = slash ? allCommands.filter(command => command.name.startsWith(slash[1].toLowerCase())) : [];
  const choices = tokenKind === '@' ? candidates.map(person => ({ id:person.userId, label:`@${person.username}`, detail:person.displayName ?? '', value:`@${person.username} `, token:`@[user:${person.userId}]` })) : tokenKind === '#' ? channels.filter(channel => channel.name.toLowerCase().startsWith(tokenQuery.toLowerCase())).slice(0,8).map(channel => ({ id:channel.id,label:`#${channel.name}`,detail:'Channel',value:`#${channel.name} `, token:`#[channel:${channel.id}]` })) : commandChoices.map(command => ({id:command.name,label:`/${command.name}`,detail:command.description,value:`/${command.name} `}));
  const showSuggestions = !menu && dismissed !== tokenKey && choices.length > 0;
  useEffect(() => {
    setSelected(0); setCandidates([]);
    if (tokenKind !== '@' || !owner || reason) return;
    let active = true;
    const timer = setTimeout(() => { apiData<Candidate[]>(`/api/channels/${channelId}/mention-candidates?q=${encodeURIComponent(tokenQuery)}`).then(data => { if (active) setCandidates(data); }).catch(() => {}); },150);
    return () => { active = false; clearTimeout(timer); };
  }, [tokenKind, tokenQuery, channelId, owner, reason]);
  function choose(index: number) {
    const item = choices[index]; if (!item) return;
    const mapped = (item as { token?: string }).token; if (mapped) picked.current.set(item.value.trim(), mapped);
    const from = token ? caret-tokenQuery.length-1 : 0;
    selectRange(body.slice(0,from)+item.value+body.slice(caret),from+item.value.length); setDismissed('');
  }
  async function submit() {
    if (reason || !ready || busy || uploading || (!body.trim() && !files.length)) return;
    setBusy(true); setError(''); setNotice(''); setMenu(null);
    const sent = body;
    const out = encode(body);
    try {
      const match = secret ? null : /^\/(poll|remind|status|shrug)(?:\s|$)/i.exec(body);
      if (match) {
        const name = match[1].toLowerCase(), text = body.slice(match[0].length).trim();
        if (name === 'poll') { const poll = pollCommand(text); if (files.length) throw new Error('Send attachments separately from a poll.'); if (await onSend(poll.question,[],{kind:'poll',poll}) === false) throw new Error('Poll was not sent. Retry the message.'); }
        else if (name === 'remind') { const parsed = parseWhen(text); if (!parsed?.rest || parsed.rest.length>500) throw new Error('Use /remind in 30m text, /remind tomorrow 9am text, or /remind at 15:30 text.'); await apiData('/api/reminders',{method:'POST',body:JSON.stringify({text:parsed.rest,remindAt:parsed.when.toISOString()})}); setNotice('Reminder saved.'); }
        else if (name === 'status') {
          let emoji = '', status = '';
          if (text !== 'clear') { const parts = /^:([\w+-]+):\s*(.+)$/.exec(text); if (!parts) throw new Error('Use /status :emoji: text or /status clear.'); const aliases: Record<string,string> = { smile:'😀',thumbsup:'👍',heart:'❤️',tada:'🎉' }; emoji = aliases[parts[1]] ?? emojiData.find(item => item.name === parts[1].replace(/_/g,' ') || item.keywords.includes(parts[1]))?.emoji ?? ''; status=parts[2]; if (!emoji || status.length>80) throw new Error('Choose a known emoji name and status up to 80 characters.'); }
          updateUser(await apiData('/api/me',{method:'PATCH',body:JSON.stringify({status_emoji:emoji,status_text:status})})); setNotice('Status updated.');
        } else if (await onSend(`${text}${text ? ' ' : ''}¯\\_(ツ)_/¯`,files) === false) throw new Error('Message was not sent. Retry the message.');
      } else if (!secret && custom.some(item => new RegExp('^/' + item.name + '(?:\\s|$)', 'i').test(body))) {
        const name = /^\/([\w-]+)/.exec(body)![1].toLowerCase(), text = body.slice(name.length + 1).trim();
        if (files.length) throw new Error('Commands cannot include attachments.');
        const answer = await apiData<{ ephemeral: boolean; text?: string; botName?: string }>(`/api/channels/${channelId}/commands/run`, { method: 'POST', body: JSON.stringify({ command: name, text, parentId }) });
        if (answer.ephemeral) { clear(sent); setNotice(`${answer.botName}: ${answer.text} (only visible to you)`); return; }
      } else if (await onSend(out,files,viewOnce&&files.length?{viewOnce:true}:undefined) === false) throw new Error('Message was not sent. Retry the message.');
      clear(sent);
    } catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  async function schedule(date: Date) {
    if (!Number.isFinite(date.getTime()) || date.getTime()<=Date.now()) { setError('Choose a future date and time.'); return; }
    if (reason || busy || uploading || (!body.trim() && !files.length)) return;
    if (/^\/(poll|remind|status|shrug)(?:\s|$)/i.test(body) || custom.some(item => body.toLowerCase().startsWith(`/${item.name}`))) { setError('Use Send for slash commands. Send later schedules ordinary messages.'); return; }
    setBusy(true); setError('');
    try { await apiData(`/api/channels/${channelId}/scheduled`,{method:'POST',body:JSON.stringify({body:encode(body),parentId,attachmentIds:files.map(file=>file.id),sendAt:date.toISOString()})}); clear(); setNotice('Message scheduled. Find it under Drafts & scheduled.'); setMenu(null); }
    catch (cause) { setError(requestError(cause)); } finally { setBusy(false); }
  }
  const disabled = !!reason || busy || !ready;
  const tool = 'flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-sm text-white/70 hover:bg-brand-soft hover:text-brand disabled:opacity-40';
  const popover = 'on-surface absolute bottom-full left-2 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-white/10 bg-surface p-3 text-white shadow-[var(--shadow-pop)]';
  const applyLink = () => { const safe = safeLinkUrl(url); if (!safe) { setError('Use an http, https or mailto URL.'); return; } const {start,end}=selection.current; const label=body.slice(start,end)||'link'; selectRange(body.slice(0,start)+`[${label}](${safe})`+body.slice(end),start+label.length+safe.length+4); setMenu(null); setUrl(''); };
  return <form className="relative rounded-2xl border border-white/12 bg-surface shadow-[var(--shadow-card)] focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15" onSubmit={event=>{event.preventDefault();void submit();}} onDragOver={event=>{if(!disabled)event.preventDefault();}} onDrop={event=>{if(disabled)return;event.preventDefault();uploads.current?.add(Array.from(event.dataTransfer.files));}}>
    {!reason && !secret && <UploadPicker key={pickerKey} compact controls={uploads} path={`/api/channels/${channelId}/uploads`} onChange={setFiles} onBusy={setUploading} />}
    {secret && <p className="flex items-center gap-1.5 border-b border-white/5 px-4 py-1.5 text-xs text-white/60"><Icon name="lock" size={13} />End-to-end encrypted. Text only.</p>}
    {!secret && <div role="toolbar" aria-label="Message formatting" className="flex flex-wrap items-center gap-0.5 border-b border-white/5 px-2 py-1">{formats.map((item,index)=><button key={item.id} type="button" title={`${item.label} (${item.shortcut})`} aria-label={item.label} disabled={disabled} className={`${tool} ${index>3?'hidden sm:flex':''}`} onMouseDown={event=>event.preventDefault()} onClick={()=>format(item.id)}>{item.mark}</button>)}<button type="button" title="Link (Ctrl/Cmd+K)" aria-label="Link" disabled={disabled} className={tool} onClick={()=>{setMenu(menu==='link'?null:'link');setUrl('');}}>↗</button><button type="button" title="More formatting" aria-label="More formatting" aria-expanded={menu==='more'} disabled={disabled} className={`${tool} sm:hidden`} onClick={()=>setMenu(menu==='more'?null:'more')}>…</button><button type="button" title="Formatting help" aria-label="Formatting help" className={`${tool} ml-auto`} onClick={()=>setMenu(menu==='help'?null:'help')}>?</button></div>}
    {allowViewOnce&&files.some(file=>file.kind==='image'||file.kind==='video')&&<label className="flex cursor-pointer items-start gap-2 border-b border-white/5 px-4 py-2 text-sm"><input type="checkbox" className="mt-1 accent-[var(--brand)]" checked={viewOnce} onChange={event=>setViewOnce(event.target.checked)} /><span><span className="font-medium">View once</span><span className="block text-xs text-white/60">Each person can open it one time. It can&apos;t be saved or forwarded, and it won&apos;t appear in Files or search.</span></span></label>}
    <div className="relative">
    <div ref={mirror} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap px-4 pt-3 text-[15px] leading-6 text-white/90 [overflow-wrap:anywhere]">{highlight(body)}</div>
    <textarea ref={box} aria-label="Message" role={showSuggestions?'combobox':undefined} aria-expanded={showSuggestions} aria-controls={showSuggestions?'composer-options':undefined} aria-activedescendant={showSuggestions?`composer-option-${selected}`:undefined} placeholder={reason||placeholder} disabled={disabled} value={body} maxLength={4000} rows={1} className="relative block max-h-48 min-h-11 w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-6 text-transparent caret-[var(--fg)] outline-none [overflow-wrap:anywhere] placeholder:text-white/50 selection:bg-brand/25 selection:text-transparent disabled:opacity-60 [field-sizing:content]" onScroll={event=>{if(mirror.current)mirror.current.scrollTop=event.currentTarget.scrollTop;}} onChange={event=>change(event.target.value,event.target.selectionStart)} onSelect={event=>{selection.current={start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd};setCaret(event.currentTarget.selectionStart);}} onBlur={stopTyping} onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(null);setDismissed(tokenKey);return;}
      if(showSuggestions&&['ArrowDown','ArrowUp','Enter','Tab'].includes(event.key)){event.preventDefault();if(event.key==='ArrowDown')setSelected(index=>(index+1)%choices.length);else if(event.key==='ArrowUp')setSelected(index=>(index+choices.length-1)%choices.length);else choose(Math.min(selected,choices.length-1));return;}
      if(event.ctrlKey||event.metaKey){let action:FormatAction|undefined;const key=event.key.toLowerCase();if(!event.shiftKey)action=({b:'bold',i:'italic',e:'code'} as Record<string,FormatAction>)[key];else action=({x:'strike',c:'block','7':'number','8':'bullet','9':'quote','&':'number','*':'bullet','(':'quote'} as Record<string,FormatAction>)[key];if(action||key==='k'){event.preventDefault();event.stopPropagation();if(action)format(action);else{setMenu('link');setUrl('');}return;}}
      if(event.key==='ArrowUp'&&!body){event.preventDefault();onEditLast?.();}
      if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void submit();}
    }}/>
    </div>
    <div className="flex flex-wrap items-center gap-1 px-2 pb-2 pt-1">{!secret&&<button type="button" className={tool} disabled={disabled} aria-label="Attach files" title="Attach files" onClick={()=>uploads.current?.open()}><Icon name="plus" /></button>}{!secret&&<RewriteButton body={body} disabled={disabled||uploading} onUse={text=>selectRange(text,text.length)} />}<button type="button" className={tool} disabled={disabled} aria-label="Insert emoji" title="Insert emoji" aria-expanded={menu==='emoji'} onClick={()=>setMenu(menu==='emoji'?null:'emoji')}>☺</button>{!secret&&<button type="button" className={tool} disabled={disabled} aria-label="Mention someone" title="Mention someone" onClick={()=>insert('@')}><Icon name="at" /></button>}<span className="hidden min-w-0 flex-1 truncate text-xs text-white/60 sm:inline">{reason||(uploading?'Uploading…':`${body.length}/4000 · Enter to send`)}</span><button type="submit" title="Send" aria-label="Send" disabled={disabled||uploading||(!body.trim()&&!files.length)} className="ml-auto flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-white disabled:opacity-40"><Icon name="send" size={17} /></button>{!secret&&<button type="button" className={tool} title="Send later" aria-label="Send later" disabled={disabled||uploading||(!body.trim()&&!files.length)} aria-expanded={menu==='later'} onClick={()=>setMenu(menu==='later'?null:'later')}>⌄</button>}</div>
    {!reason && !secret && <div className="px-3 pb-2"><VoiceRecorder disabled={disabled||uploading||files.length>0} onError={setError} onReady={async(file,durationMs,waveform)=>{
      setBusy(true);setError('');try{const form=new FormData();form.append('file',file);form.append('kind','audio');form.append('durationMs',String(durationMs));form.append('waveform',JSON.stringify(waveform));const attachment=await responseData<Attachment>(await apiFetch(`/api/channels/${channelId}/uploads`,{method:'POST',body:form}));if(await onSend(encode(body),[attachment],{kind:'voice'})===false)throw new Error('Voice message was not sent. Retry the message.');clear();}catch(cause){setError(requestError(cause));}finally{setBusy(false);}
    }}/></div>}
    {error&&<p role="alert" className="px-4 pb-2 text-sm text-rose-500">{error}</p>}{notice&&<p role="status" className="px-4 pb-2 text-sm text-brand">{notice}</p>}
    {menu==='emoji'&&<div className="absolute bottom-full left-2 z-30 mb-2"><EmojiPicker onSelect={value=>{insert(value);setMenu(null);}} onClose={()=>{setMenu(null);box.current?.focus();}} /></div>}
    {menu==='more'&&<div className={popover} role="toolbar" aria-label="More formatting">{formats.slice(4).map(item=><button key={item.id} type="button" className="btn-ghost mr-2 mb-2" onClick={()=>{format(item.id);setMenu(null);}}>{item.label}</button>)}</div>}
    {menu==='help'&&<section className={popover} aria-label="Formatting help"><h3 className="mb-2 font-bold">Formatting help</h3>{formats.map(item=><p key={item.id} className="flex justify-between gap-3 text-xs leading-6"><span>{item.label}</span><kbd>{item.shortcut}</kbd></p>)}<p className="mt-2 text-xs">Ctrl/Cmd+K links · Enter sends · Shift+Enter adds a line · Escape closes menus</p><button type="button" className="btn-ghost mt-2" onClick={()=>setMenu(null)}>Close</button></section>}
    {menu==='link'&&<div className={popover} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setMenu(null);box.current?.focus();}if(event.key==='Enter'){event.preventDefault();applyLink();}}}><label className="text-sm">Link URL<input autoFocus className="auth-input" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://example.com" /></label><div className="mt-3 flex gap-2"><button type="button" className="auth-button" onClick={applyLink}>Insert link</button><button type="button" className="btn-ghost" onClick={()=>setMenu(null)}>Cancel</button></div></div>}
    {menu==='later'&&<section className={popover} aria-label="Send later"><h3 className="mb-2 font-bold">Send later</h3><button type="button" className="btn-ghost mb-2 w-full" onClick={()=>void schedule(new Date(Date.now()+3600000))}>In 1 hour</button><button type="button" className="btn-ghost mb-3 w-full" onClick={()=>{const date=new Date();date.setDate(date.getDate()+1);date.setHours(9,0,0,0);void schedule(date);}}>Tomorrow 9 AM</button><label className="text-sm">Custom date and time<input className="auth-input" type="datetime-local" value={when} onChange={event=>setWhen(event.target.value)} /></label><button type="button" className="auth-button mt-3" onClick={()=>void schedule(new Date(when))}>Schedule message</button><a className="mt-3 block text-sm text-brand underline" href="/home?view=drafts">Manage scheduled messages</a></section>}
    {showSuggestions&&<ul id="composer-options" role="listbox" aria-label={tokenKind?'Mention or channel suggestions':'Slash commands'} className={`${popover} max-h-60 overflow-y-auto p-1`}>{choices.map((choice,index)=><li key={choice.id} role="presentation"><button id={`composer-option-${index}`} type="button" role="option" aria-selected={selected===index} tabIndex={-1} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)} className={`flex w-full flex-col rounded-lg px-3 py-2 text-left ${index===selected?'bg-brand text-white':'hover:bg-brand-soft'}`}><span className="font-medium">{choice.label}</span><span className="text-xs">{choice.detail}</span></button></li>)}</ul>}
  </form>;
}
