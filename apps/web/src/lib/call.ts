'use client';

import { chatRequest, socket } from './socket';

/**
 * Peer-to-peer (mesh) WebRTC calls. The server only relays signalling between sockets in the
 * same call; audio/video flows browser to browser. Each pair of participants has one
 * RTCPeerConnection, negotiated with the "perfect negotiation" pattern so both sides can add
 * tracks at any time without offer collisions (the "polite" peer yields).
 */

export type Peer = {
  sid: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  muted: boolean;
  camera: boolean;
  screen: boolean;
  stream: MediaStream | null;
  speaking: boolean;
  hand?: boolean;
};

export type Caption = { id: string; sid: string; username: string; text: string; final: boolean };
export type Reaction = { id: string; sid: string; emoji: string };
export const REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const;

export type CallState = {
  channelId: string | null;
  /** Name of the place the call is in, shown in the call bar while you browse elsewhere. */
  title: string;
  /** Whether the floating participant tiles are open. */
  stageOpen: boolean;
  status: 'idle' | 'joining' | 'connected' | 'error';
  error: string;
  muted: boolean;
  camera: boolean;
  screen: boolean;
  localStream: MediaStream | null;
  speaking: boolean;
  peers: Peer[];
  hand: boolean;
  /** This browser transcribes your speech and shares it with the call. */
  captionsOn: boolean;
  /** Recent caption lines from everyone (including you), newest last. */
  captions: Caption[];
  /** Emoji reactions floating over tiles for a few seconds. */
  reactions: Reaction[];
};

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type Link = {
  pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; stream: MediaStream;
  audioSender: RTCRtpSender | null; videoSender: RTCRtpSender | null;
};

/** Plain-words explanation for a failed getUserMedia / getDisplayMedia request. */
export function deviceMessage(device: 'microphone' | 'camera', cause: unknown): string {
  const name = cause instanceof DOMException ? cause.name : '';
  if (!navigator.mediaDevices) return `Hive can't use your ${device} on an insecure connection. Open the site over https.`;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Hive can't use your ${device}. Allow it in the browser's address bar, then try again.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${device} found. Plug one in and try again.`;
  if (name === 'NotReadableError' || name === 'AbortError') return `Your ${device} is being used by another app. Close it there and try again.`;
  return `Hive couldn't start your ${device}.`;
}

const idle: CallState = {
  channelId: null, title: '', stageOpen: false, status: 'idle', error: '', muted: false, camera: false, screen: false,
  localStream: null, speaking: false, peers: [], hand: false, captionsOn: false, captions: [], reactions: [],
};

type Recognition = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null };
const recognitionClass = () => typeof window === 'undefined' ? null
  : ((window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition ?? null);
export const captionsSupported = () => !!recognitionClass();

class CallManager {
  state: CallState = idle;
  private listeners = new Set<() => void>();
  private links = new Map<string, Link>();
  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private audio: MediaStreamTrack | null = null;
  private video: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private meters = new Map<string, () => void>();
  private audioContext: AudioContext | null = null;
  /** Signals that arrive before the join is acknowledged (we don't have ICE servers yet). */
  private queued: [string, Signal][] = [];
  private recognition: Recognition | null = null;
  private lastInterim = 0;

  constructor() {
    if (typeof window === 'undefined') return;
    socket.on('call:peer-joined', (peer: Omit<Peer, 'stream' | 'speaking'> & { channelId: string }) => {
      if (peer.channelId !== this.state.channelId) return;
      this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.connect(peer.sid);
      this.emit();
    });
    socket.on('call:peer-left', (data: { channelId: string; sid: string }) => {
      if (data.channelId === this.state.channelId) this.drop(data.sid);
    });
    socket.on('call:state', (data: { channelId: string; sid: string; muted: boolean; camera: boolean; screen: boolean; hand?: boolean }) => {
      const peer = this.peers.get(data.sid);
      if (!peer || data.channelId !== this.state.channelId) return;
      this.peers.set(data.sid, { ...peer, muted: data.muted, camera: data.camera, screen: data.screen, hand: !!data.hand });
      // Someone started sharing their screen: show it right away instead of waiting for a click.
      this.emit(data.screen && !peer.screen ? { stageOpen: true } : {});
    });
    socket.on('call:react', (data: { channelId: string; sid: string; emoji: string }) => {
      if (data.channelId === this.state.channelId) this.showReaction(data.sid, data.emoji);
    });
    socket.on('call:caption', (data: { channelId: string; sid: string; username: string; text: string; final: boolean }) => {
      if (data.channelId === this.state.channelId) this.addCaption(data.sid, data.username, data.text, data.final);
    });
    socket.on('call:signal', (data: { channelId: string; from: string; data: Signal }) => {
      if (data.channelId === this.state.channelId) void this.onSignal(data.from, data.data);
    });
    socket.on('call:removed', (data: { channelId: string }) => {
      if (data.channelId !== this.state.channelId) return;
      this.hangUp();
      this.emit({ ...idle, error: 'You no longer have access to that huddle.' });
    });
    // After a reconnect the server has forgotten this socket: join again with fresh connections.
    socket.on('connect', () => {
      const channelId = this.state.channelId;
      if (channelId && this.state.status === 'connected') { this.resetLinks(); void this.join(channelId); }
    });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;

  private emit(patch: Partial<CallState> = {}) {
    this.state = { ...this.state, ...patch, peers: [...this.peers.values()] };
    this.listeners.forEach(listener => listener());
  }

  setStageOpen(stageOpen: boolean) { this.emit({ stageOpen }); }

  async join(channelId: string, title = '') {
    if (this.state.channelId === channelId && this.state.status !== 'idle' && this.state.status !== 'error') return;
    if (this.state.channelId && this.state.channelId !== channelId) await this.leave();
    this.emit({ channelId, title, status: 'joining', error: '' });
    void this.audioContext?.resume();
    if (!this.audio) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audio = media.getAudioTracks()[0];
      } catch (cause) {
        // No microphone or permission denied: join muted so the user can still listen and watch.
        this.emit({ muted: true, error: `${deviceMessage('microphone', cause)} You joined muted.` });
      }
    }
    try {
      const result = await chatRequest<{ iceServers: RTCIceServer[]; peers: Omit<Peer, 'stream' | 'speaking'>[] }>(
        'call:join', { channelId });
      this.iceServers = result.iceServers;
      for (const peer of result.peers) this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.updateLocalStream();
      for (const peer of result.peers) this.connect(peer.sid);
      this.emit({ status: 'connected' });
      for (const [from, signal] of this.queued.splice(0)) void this.onSignal(from, signal);
      void chatRequest('call:state', { channelId, muted: this.state.muted || !this.audio, camera: this.state.camera, screen: this.state.screen, hand: this.state.hand }).catch(() => {});
    } catch (cause) {
      this.hangUp();
      this.emit({ ...idle, status: 'error', error: cause instanceof Error ? cause.message : 'Could not join the huddle.' });
    }
  }

  async leave() {
    const channelId = this.state.channelId;
    if (channelId && socket.connected) await chatRequest('call:leave', { channelId }).catch(() => {});
    this.hangUp();
    this.emit({ ...idle });
  }

  /** Closes every connection and releases the microphone, camera and screen. */
  toggleHand() {
    this.emit({ hand: !this.state.hand });
    this.sendState();
  }

  react(emoji: string) {
    const channelId = this.state.channelId;
    if (!channelId) return;
    this.showReaction(socket.id ?? 'me', emoji);
    void chatRequest('call:react', { channelId, emoji }).catch(() => {});
  }

  private showReaction(sid: string, emoji: string) {
    const id = `${sid}-${Date.now()}-${Math.random()}`;
    this.emit({ reactions: [...this.state.reactions, { id, sid, emoji }].slice(-12) });
    setTimeout(() => this.emit({ reactions: this.state.reactions.filter(item => item.id !== id) }), 3500);
  }

  private addCaption(sid: string, username: string, text: string, final: boolean) {
    const captions = [...this.state.captions];
    const last = captions.findLastIndex(item => item.sid === sid);
    if (last >= 0 && !captions[last].final) captions[last] = { ...captions[last], text, final };
    else captions.push({ id: `${sid}-${Date.now()}`, sid, username, text, final });
    this.emit({ captions: captions.slice(-40) });
  }

  /** Live captions: the browser transcribes your microphone and shares the words with the call. */
  toggleCaptions(username: string) {
    if (this.recognition) { this.stopCaptions(); return; }
    const Speech = recognitionClass();
    if (!Speech) { this.emit({ error: 'Live captions need Chrome or Edge on a computer.' }); return; }
    const recognition = new Speech();
    recognition.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      const result = event.results[event.results.length - 1];
      const text = result[0]?.transcript.trim();
      const channelId = this.state.channelId;
      if (!text || !channelId) return;
      this.addCaption(socket.id ?? 'me', username, text, result.isFinal);
      if (!result.isFinal && Date.now() - this.lastInterim < 700) return;
      this.lastInterim = Date.now();
      void chatRequest('call:caption', { channelId, text: text.slice(-300), final: result.isFinal }).catch(() => {});
    };
    recognition.onerror = event => { if (event.error === 'not-allowed') { this.stopCaptions(); this.emit({ error: 'Captions need microphone access.' }); } };
    // Recognition stops by itself after a pause; keep it going while captions are on.
    recognition.onend = () => { if (this.recognition === recognition && this.state.channelId) { try { recognition.start(); } catch { this.stopCaptions(); } } };
    this.recognition = recognition;
    try { recognition.start(); this.emit({ captionsOn: true }); } catch { this.stopCaptions(); }
  }

  private stopCaptions() {
    const recognition = this.recognition;
    this.recognition = null;
    try { recognition?.stop(); } catch { /* already stopped */ }
    this.emit({ captionsOn: false });
  }

  private hangUp() {
    this.stopCaptions();
    this.resetLinks();
    this.stopTracks();
    this.peers.clear();
    this.queued = [];
  }

  async ring(channelId: string) { await chatRequest('call:ring', { channelId }); }

  toggleMute() {
    if (!this.audio) return;
    const muted = !this.state.muted;
    this.audio.enabled = !muted;
    this.emit({ muted });
    this.sendState();
  }

  async toggleCamera() {
    if (this.state.camera) {
      this.cameraTrack?.stop();
      this.cameraTrack = null;
      if (!this.state.screen) this.setVideo(null);
      this.emit({ camera: false });
    } else {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } });
        this.cameraTrack = media.getVideoTracks()[0];
        if (!this.state.screen) this.setVideo(this.cameraTrack);
        this.emit({ camera: true, error: '' });
      } catch (cause) {
        this.emit({ error: deviceMessage('camera', cause) });
      }
    }
    this.sendState();
  }

  async toggleScreen() {
    if (this.state.screen) {
      this.video?.stop();
      this.setVideo(this.cameraTrack);
      this.emit({ screen: false });
    } else {
      try {
        const media = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = media.getVideoTracks()[0];
        track.onended = () => { if (this.state.screen) void this.toggleScreen(); };
        this.setVideo(track);
        this.emit({ screen: true, error: '' });
      } catch (cause) {
        // Closing the picker is not an error; anything else (unsupported, blocked) is explained.
        if (!(cause instanceof DOMException && cause.name === 'NotAllowedError' && /cancel|dismiss|denied by user/i.test(cause.message)))
          this.emit({ error: cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Screen sharing was blocked. Allow it when your browser asks, or check its screen-recording permission.'
            : 'Screen sharing is not available in this browser. Try Chrome, Edge or Firefox on a computer.' });
        return;
      }
    }
    this.sendState();
  }

  async useMicrophone(deviceId: string) {
    let track: MediaStreamTrack;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      track = media.getAudioTracks()[0];
    } catch (cause) {
      this.emit({ error: deviceMessage('microphone', cause) });
      return;
    }
    track.enabled = !this.state.muted;
    this.audio?.stop();
    this.audio = track;
    for (const link of this.links.values()) {
      if (link.audioSender) await link.audioSender.replaceTrack(track);
      else link.audioSender = link.pc.addTrack(track);
    }
    this.updateLocalStream();
  }

  private sendState() {
    const { channelId, muted, camera, screen } = this.state;
    if (channelId) void chatRequest('call:state', { channelId, muted, camera, screen, hand: this.state.hand }).catch(() => {});
  }

  /** Swap the outgoing video (camera, screen or none) on every connection. */
  private setVideo(track: MediaStreamTrack | null) {
    this.video = track;
    for (const link of this.links.values()) {
      // replaceTrack avoids renegotiation; adding the first video track triggers it once.
      if (link.videoSender) void link.videoSender.replaceTrack(track);
      else if (track) link.videoSender = link.pc.addTrack(track);
    }
    this.updateLocalStream();
  }

  private updateLocalStream() {
    const tracks = [this.audio, this.video].filter((track): track is MediaStreamTrack => !!track);
    const stream = tracks.length ? new MediaStream(tracks) : null;
    this.meter('local', stream);
    this.emit({ localStream: stream });
  }

  private connect(sid: string) {
    if (this.links.has(sid)) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const link: Link = {
      pc, polite: socket.id! > sid, makingOffer: false, ignoreOffer: false, stream: new MediaStream(),
      audioSender: this.audio ? pc.addTrack(this.audio) : null,
      videoSender: this.video ? pc.addTrack(this.video) : null,
    };
    this.links.set(sid, link);
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(sid, { description: pc.localDescription!.toJSON() });
      } finally { link.makingOffer = false; }
    };
    pc.onicecandidate = event => { if (event.candidate) this.signal(sid, { candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      link.stream.addTrack(event.track);
      event.track.onended = () => { link.stream.removeTrack(event.track); this.setPeerStream(sid, link.stream); };
      event.track.onunmute = () => this.setPeerStream(sid, link.stream);
      this.setPeerStream(sid, link.stream);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  }

  private setPeerStream(sid: string, stream: MediaStream) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    const fresh = new MediaStream(stream.getTracks());
    this.peers.set(sid, { ...peer, stream: fresh });
    this.meter(sid, fresh);
    this.emit();
  }

  private async onSignal(from: string, { description, candidate }: Signal) {
    if (this.state.status === 'joining') { this.queued.push([from, { description, candidate }]); return; }
    if (!this.links.has(from)) this.connect(from);
    const link = this.links.get(from)!;
    try {
      if (description) {
        const collision = description.type === 'offer' && (link.makingOffer || link.pc.signalingState !== 'stable');
        link.ignoreOffer = !link.polite && collision;
        if (link.ignoreOffer) return;
        await link.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await link.pc.setLocalDescription();
          this.signal(from, { description: link.pc.localDescription!.toJSON() });
        }
      } else if (candidate) {
        try { await link.pc.addIceCandidate(candidate); }
        catch (error) { if (!link.ignoreOffer) throw error; }
      }
    } catch {
      // A failed negotiation step is retried by the next negotiationneeded/ICE restart.
    }
  }

  private signal(to: string, data: Signal) {
    const channelId = this.state.channelId;
    if (channelId) void chatRequest('call:signal', { channelId, to, data }).catch(() => {});
  }

  private drop(sid: string) {
    this.links.get(sid)?.pc.close();
    this.links.delete(sid);
    this.meters.get(sid)?.();
    this.meters.delete(sid);
    this.peers.delete(sid);
    this.emit();
  }

  private resetLinks() {
    for (const sid of [...this.links.keys()]) this.drop(sid);
  }

  private stopTracks() {
    this.audio?.stop(); this.video?.stop(); this.cameraTrack?.stop();
    this.audio = this.video = this.cameraTrack = null;
    this.meters.get('local')?.(); this.meters.delete('local');
  }

  /** Speaking indicator: watch the audio level of a stream a few times per second. */
  private meter(key: string, stream: MediaStream | null) {
    this.meters.get(key)?.();
    this.meters.delete(key);
    if (!stream?.getAudioTracks().length) return;
    this.audioContext ??= new AudioContext();
    const source = this.audioContext.createMediaStreamSource(stream);
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += (value - 128) ** 2;
      const speaking = Math.sqrt(sum / samples.length) > 6;
      if (key === 'local') { if (speaking !== this.state.speaking) this.emit({ speaking }); return; }
      const peer = this.peers.get(key);
      if (peer && peer.speaking !== speaking) { this.peers.set(key, { ...peer, speaking }); this.emit(); }
    }, 200);
    this.meters.set(key, () => { clearInterval(timer); source.disconnect(); });
  }
}

export const calls = new CallManager();
