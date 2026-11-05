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
  muted: boolean;
  camera: boolean;
  screen: boolean;
  stream: MediaStream | null;
  speaking: boolean;
};

export type CallState = {
  channelId: string | null;
  status: 'idle' | 'joining' | 'connected' | 'error';
  error: string;
  muted: boolean;
  camera: boolean;
  screen: boolean;
  localStream: MediaStream | null;
  speaking: boolean;
  peers: Peer[];
};

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type Link = {
  pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; stream: MediaStream;
  audioSender: RTCRtpSender | null; videoSender: RTCRtpSender | null;
};

const idle: CallState = {
  channelId: null, status: 'idle', error: '', muted: false, camera: false, screen: false,
  localStream: null, speaking: false, peers: [],
};

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
    socket.on('call:state', (data: { channelId: string; sid: string; muted: boolean; camera: boolean; screen: boolean }) => {
      const peer = this.peers.get(data.sid);
      if (!peer || data.channelId !== this.state.channelId) return;
      this.peers.set(data.sid, { ...peer, muted: data.muted, camera: data.camera, screen: data.screen });
      this.emit();
    });
    socket.on('call:signal', (data: { channelId: string; from: string; data: Signal }) => {
      if (data.channelId === this.state.channelId) void this.onSignal(data.from, data.data);
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

  async join(channelId: string) {
    if (this.state.channelId && this.state.channelId !== channelId) await this.leave();
    this.emit({ channelId, status: 'joining', error: '' });
    if (!this.audio) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.audio = media.getAudioTracks()[0];
      } catch {
        // No microphone or permission denied: join muted so the user can still listen and watch.
        this.emit({ muted: true, error: 'Microphone unavailable: you joined muted.' });
      }
    }
    try {
      const result = await chatRequest<{ iceServers: RTCIceServer[]; peers: Omit<Peer, 'stream' | 'speaking'>[] }>(
        'call:join', { channelId });
      this.iceServers = result.iceServers;
      this.peers.clear();
      for (const peer of result.peers) this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.updateLocalStream();
      for (const peer of result.peers) this.connect(peer.sid);
      this.emit({ status: 'connected' });
      void chatRequest('call:state', { channelId, muted: this.state.muted || !this.audio, camera: this.state.camera, screen: this.state.screen }).catch(() => {});
    } catch (cause) {
      this.stopTracks();
      this.emit({ ...idle, status: 'error', error: cause instanceof Error ? cause.message : 'Could not join the call.' });
    }
  }

  async leave() {
    const channelId = this.state.channelId;
    if (channelId && socket.connected) await chatRequest('call:leave', { channelId }).catch(() => {});
    this.resetLinks();
    this.stopTracks();
    this.peers.clear();
    this.emit({ ...idle });
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
      } catch {
        this.emit({ error: 'Camera unavailable or permission denied.' });
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
      } catch {
        return; // the user cancelled the screen picker
      }
    }
    this.sendState();
  }

  async useMicrophone(deviceId: string) {
    const media = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    const track = media.getAudioTracks()[0];
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
    if (channelId) void chatRequest('call:state', { channelId, muted, camera, screen }).catch(() => {});
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
