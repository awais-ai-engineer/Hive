'use client';

import { useEffect, useRef } from 'react';
import { useCall } from '../../lib/use-call';
import { CallStage } from './call-stage';
import { IncomingCall } from './incoming-call';

function PeerAudio({ stream }: { stream: MediaStream | null }) {
  const element = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  return <audio ref={element} autoPlay />;
}

/**
 * Mounted once for the whole /home page: plays everyone's sound (so a huddle keeps going while you
 * switch channels), shows the floating tiles and the ringing toast.
 */
export function CallDock({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept: (channelId: string) => void }) {
  const call = useCall();
  return <>
    {call.peers.map(peer => <PeerAudio key={peer.sid} stream={peer.stream} />)}
    <CallStage />
    <IncomingCall titleFor={titleFor} onAccept={onAccept} />
  </>;
}
