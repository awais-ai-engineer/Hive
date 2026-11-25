'use client';

import { useEffect, useRef } from 'react';
import { useCall } from '../../lib/use-call';
import { CallStage } from './call-stage';
import { IncomingCall } from './incoming-call';
import { PrejoinDialog } from './prejoin-dialog';

function PeerAudio({ stream }: { stream: MediaStream | null }) {
  const element = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (element.current && element.current.srcObject !== stream) element.current.srcObject = stream;
  }, [stream]);
  return <audio ref={element} autoPlay />;
}

/**
 * Mounted once in the authenticated app shell: keeps remote audio playing across navigation,
 * and hosts the shared Huddle stage, invitation toast and pre-join dialog.
 */
export function CallDock({ titleFor, onAccept }: { titleFor: (channelId: string, caller: string) => string; onAccept: (channelId: string) => void }) {
  const call = useCall();
  return <>
    {call.peers.map(peer => <PeerAudio key={peer.sid} stream={peer.stream} />)}
    <CallStage />
    <IncomingCall titleFor={titleFor} onAccept={onAccept} />
    <PrejoinDialog />
  </>;
}
