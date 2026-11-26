'use client';

import { Button } from '@hive/ui';
import { useEffect, useRef, useState } from 'react';
import { useCall } from '../../lib/use-call';
import { CallStage } from './call-stage';
import { IncomingCall } from './incoming-call';
import { PrejoinDialog } from './prejoin-dialog';

function PeerAudio({ stream, onBlocked }: { stream: MediaStream | null; onBlocked: (blocked: boolean) => void }) {
  const element = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    const play = () => { if (stream?.getAudioTracks().length) void audio.play().then(() => onBlocked(false)).catch(() => onBlocked(true)); };
    play();
    stream?.addEventListener('addtrack', play);
    window.addEventListener('pointerdown', play);
    window.addEventListener('keydown', play);
    window.addEventListener('hive:resume-audio', play);
    return () => { stream?.removeEventListener('addtrack', play); window.removeEventListener('pointerdown', play); window.removeEventListener('keydown', play); window.removeEventListener('hive:resume-audio', play); };
  }, [stream]);
  return <audio ref={element} autoPlay />;
}

/**
 * Mounted once in the authenticated app shell: keeps remote audio playing across navigation,
 * and hosts the shared Huddle stage, invitation toast and pre-join dialog.
 */
export function CallDock({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept: (channelId: string) => void }) {
  const call = useCall();
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  return <>
    {call.peers.map(peer => <PeerAudio key={peer.sid} stream={peer.stream} onBlocked={value => setBlocked(previous => { const next = new Set(previous); if (value) next.add(peer.sid); else next.delete(peer.sid); return next; })} />)}
    {call.peers.some(peer => blocked.has(peer.sid)) && call.channelId && <Button type="button" className="auth-button fixed bottom-24 right-4 z-50 !w-auto" onClick={() => window.dispatchEvent(new Event('hive:resume-audio'))}>Resume Huddle audio</Button>}
    <CallStage />
    <IncomingCall titleFor={titleFor} onAccept={onAccept} />
    <PrejoinDialog />
  </>;
}
