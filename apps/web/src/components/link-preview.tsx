'use client';

import { useEffect, useState } from 'react';
import { apiData } from '../lib/spaces';

type Preview = {url:string;host:string;title:string;description:string;image:string|null;siteName:string};
const cache=new Map<string,Promise<Preview|null>>();
export function LinkPreview({source,messageId,userId}:{source:string;messageId:string;userId?:string}) {
  const [preview,setPreview]=useState<Preview|null>(null);
  const [hidden,setHidden]=useState(false);
  const raw=/https?:\/\/[^\s<>"\]]+/i.exec(source)?.[0]?.replace(/[),.!?;:]+$/,'')??'';
  useEffect(()=>{
    setPreview(null);setHidden(false);if(!userId||!raw)return;
    let parsed:URL;try{parsed=new URL(raw);if(parsed.hostname===location.hostname)return;}catch{return;}
    let active=true;
    try{const saved=JSON.parse(localStorage.getItem(`hive:hidden-previews:${userId}`)||'[]');if(Array.isArray(saved)&&saved.includes(messageId)){setHidden(true);return;}}catch{/* Hiding is optional. */}
    const key=`${userId}:${parsed.href}`;
    if(!cache.has(key)){if(cache.size>200)cache.delete(cache.keys().next().value!);cache.set(key,apiData<Preview>(`/api/link-preview?url=${encodeURIComponent(parsed.href)}`).catch(()=>null));}
    void cache.get(key)!.then(value=>{if(active)setPreview(value);});return()=>{active=false;};
  },[raw,messageId,userId]);
  if(hidden||!preview)return null;
  return <aside className="my-2 max-w-lg rounded-xl border border-white/10 bg-canvas p-3" aria-label="Link preview"><div className="flex items-start gap-3"><a href={preview.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="min-w-0 flex-1"><p className="text-xs text-white/60">{preview.siteName||preview.host}</p><p className="my-1 break-words font-semibold text-brand">{preview.title||preview.host}</p><p className="line-clamp-3 break-words text-sm text-white/70">{preview.description}</p></a><button type="button" title="Hide preview" aria-label="Hide preview" className="rounded-lg px-2 py-1 text-white/65" onClick={()=>{setHidden(true);try{const key=`hive:hidden-previews:${userId}`;const saved=JSON.parse(localStorage.getItem(key)||'[]');localStorage.setItem(key,JSON.stringify([...new Set([...(Array.isArray(saved)?saved:[]),messageId])].slice(-200)));}catch{/* Hiding still applies in this view. */}}}>×</button></div>{preview.image&&<img src={preview.image} referrerPolicy="no-referrer" loading="lazy" alt="" className="mt-2 max-h-40 max-w-full rounded-lg object-contain" />}</aside>;
}
