'use client';

import { captionParts } from '@hive/shared';
import { announceSound, isAnnouncing, onAnnouncement, playSound, startRing, stopRing, stopHuddleAudio, type SoundEvent } from './sounds';
import { currentUserId, subscribeSession } from './api';
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
  captions?: boolean;
};

export type Caption = { id: string; sid: string; userId: string; timestamp: string; username: string; text: string; final: boolean };
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
  disclosure: string;
  outgoing: boolean;
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
  localStream: null, speaking: false, peers: [], hand: false, captionsOn: false, captions: [], reactions: [], disclosure: '', outgoing: false,
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
  private recognitionRestart: ReturnType<typeof setTimeout> | null = null;
  private recognitionFailures = 0;
  private disclosureUntil = 0;
  private outgoingInvitation: string | null = null;
  private outgoingTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private disclosedMeetings = new Set<string>();
  private lastInterim = 0;
  private pendingCaptions = new Map<string, { channelId: string; segmentId: string; text: string; final: boolean }>();
  private captionInFlight = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private captionEpoch = crypto.randomUUID();
  private captionResults = new Map<number, string>();

  constructor() {
    if (typeof window === 'undefined') return;
    onAnnouncement(playing => {
      this.disclosureUntil = playing ? Infinity : Date.now() + 600;
      const recognition = this.recognition;
      if (!recognition) return;
      if (playing) { try { recognition.stop(); } catch { /* already stopped */ } }
      else if (this.state.captionsOn && !this.recognitionRestart) this.restartRecognition(recognition, 650);
    });
    socket.on('call:disclosure', (data: { channelId: string; event: SoundEvent; id: string }) => {
      if (data.channelId !== this.state.channelId || !['transcription_started', 'transcription_stopped'].includes(data.event)) return;
      if (data.event === 'transcription_started') this.disclosedMeetings.add(data.id.split(':')[2]);
      this.emit({ disclosure: data.event === 'transcription_started' ? 'Speech transcription is active. Finalized captions are saved as meeting notes.' : 'Speech transcription has stopped.' });
      announceSound(data.event, data.id);
    });
    socket.on('call:resolved', (data: { invitationId: string; status: string }) => {
      stopRing(data.invitationId, true);
      if (data.invitationId !== this.outgoingInvitation) return;
      if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
      this.outgoingInvitation = null; this.emit({ outgoing: false });
      if (data.status === 'declined' || data.status === 'expired') playSound(data.status === 'declined' ? 'declined' : 'unanswered', 'huddles', `resolved:${data.invitationId}`);
    });
    let ownerId = currentUserId();
    subscribeSession(session => {
      if (session?.user.id !== ownerId) { this.disclosedMeetings.clear(); if (this.state.channelId) { this.hangUp(); this.emit({ ...idle }); } }
      ownerId = session?.user.id;
    });
    socket.on('call:peer-joined', (peer: Omit<Peer, 'stream' | 'speaking'> & { channelId: string }) => {
      if (peer.channelId !== this.state.channelId) return;
      if (!this.peers.has(peer.sid) && ![...this.peers.values()].some(item => item.userId === peer.userId)) playSound('participant_join', 'participants', `join:${this.state.channelId}:${peer.userId}:${peer.sid}`);
      this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.connect(peer.sid);
      this.emit();
    });
    socket.on('call:peer-left', (data: { channelId: string; sid: string }) => {
      if (data.channelId === this.state.channelId) {
        const peer = this.peers.get(data.sid);
        if (peer && ![...this.peers.values()].some(item => item.sid !== data.sid && item.userId === peer.userId)) playSound('participant_leave', 'participants', `leave:${data.sid}`);
        this.drop(data.sid);
      }
    });
    socket.on('call:state', (data: { channelId: string; sid: string; muted: boolean; camera: boolean; screen: boolean; hand?: boolean; captions?: boolean }) => {
      const peer = this.peers.get(data.sid);
      if (!peer || data.channelId !== this.state.channelId) return;
      if (data.hand && !peer.hand) playSound('hand_on', 'participants', `hand:${data.sid}:${Date.now()}`);
      this.peers.set(data.sid, { ...peer, muted: data.muted, camera: data.camera, screen: data.screen, hand: !!data.hand, captions: !!data.captions });
      // Someone started sharing their screen: show it right away instead of waiting for a click.
      this.emit(data.screen && !peer.screen ? { stageOpen: true } : {});
    });
    socket.on('call:react', (data: { channelId: string; sid: string; emoji: string }) => {
      if (data.channelId === this.state.channelId) this.showReaction(data.sid, data.emoji);
    });
    socket.on('call:caption', (data: { channelId: string; sid: string; userId: string; segmentId: string; timestamp: string; username: string; text: string; final: boolean }) => {
      if (data.channelId === this.state.channelId) this.addCaption(data.segmentId, data.sid, data.userId, data.timestamp, data.username, data.text, data.final);
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
    socket.on('disconnect', () => { if (this.state.channelId) playSound('connection_lost', 'huddles'); });
    socket.on('connect', () => {
      const channelId = this.state.channelId;
      if (channelId && this.state.status === 'connected') { this.reconnecting = true; this.resetLinks(); this.emit({ status: 'error' }); void this.joinNow(channelId, this.state.title); }
    });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;

  private emit(patch: Partial<CallState> = {}) {
    this.state = { ...this.state, ...patch, peers: [...this.peers.values()] };
    this.listeners.forEach(listener => listener());
  }

  setStageOpen(stageOpen: boolean) { this.emit({ stageOpen }); }

  /** Set by the pre-join screen: resolves with the chosen mic and camera state, or null to stay out. */
  beforeJoin: ((channelId: string, title: string) => Promise<{ muted: boolean; camera: boolean } | null>) | null = null;

  async join(channelId: string, title = '') {
    if (this.state.channelId === channelId && this.state.status !== 'idle' && this.state.status !== 'error') return;
    const choice = this.beforeJoin ? await this.beforeJoin(channelId, title) : { muted: false, camera: false };
    if (!choice) return;
    await this.joinNow(channelId, title);
    if (this.state.status !== 'connected') return;
    if (choice.muted && !this.state.muted) this.toggleMute();
    if (choice.camera && !this.state.camera) await this.toggleCamera();
  }

  /** Joins without the pre-join screen (reconnects and confirmed joins). */
  async joinNow(channelId: string, title = '') {
    if (this.state.channelId === channelId && this.state.status !== 'idle' && this.state.status !== 'error') return;
    if (this.state.channelId && this.state.channelId !== channelId) await this.leave();
    this.emit({ channelId, title, status: 'joining', error: '' });
    void this.audioContext?.resume();
    if (!this.audio) {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        this.audio = media.getAudioTracks()[0];
      } catch (cause) {
        // No microphone or permission denied: join muted so the user can still listen and watch.
        this.emit({ muted: true, error: `${deviceMessage('microphone', cause)} You joined muted.` });
      }
    }
    try {
      const result = await chatRequest<{ iceServers: RTCIceServer[]; peers: Omit<Peer, 'stream' | 'speaking'>[]; transcription: { active: boolean; meetingId: string } }>(
        'call:join', { channelId });
      this.iceServers = result.iceServers;
      for (const peer of result.peers) this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.updateLocalStream();
      for (const peer of result.peers) this.connect(peer.sid);
      this.emit({ status: 'connected' });
      stopRing();
      playSound(this.reconnecting ? 'reconnection' : 'huddle_start', 'huddles'); this.reconnecting = false;
      if (result.transcription?.active && !this.disclosedMeetings.has(result.transcription.meetingId)) {
        this.disclosedMeetings.add(result.transcription.meetingId);
        this.emit({ disclosure: 'Speech transcription is active. Finalized captions are saved as meeting notes.' });
        announceSound('transcription_active', `transcription-active:${channelId}:${result.transcription.meetingId}:${currentUserId()}`);
      }
      for (const [from, signal] of this.queued.splice(0)) void this.onSignal(from, signal);
      await chatRequest('call:state', { channelId, muted: this.state.muted || !this.audio, camera: this.state.camera, screen: this.state.screen, hand: this.state.hand, captions: this.state.captionsOn }).catch(cause => { this.stopCaptions(); this.emit({ error: cause instanceof Error ? cause.message : 'Huddle state could not be synchronized.' }); });
      this.flushCaptions();
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
    playSound('huddle_end', 'huddles');
  }

  /** Closes every connection and releases the microphone, camera and screen. */
  toggleHand() {
    playSound(this.state.hand ? 'hand_off' : 'hand_on', 'huddles');
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

  private flushCaptions() {
    if (this.captionInFlight || !socket.connected || !this.state.captionsOn || this.state.muted) return;
    const pending = [...this.pendingCaptions.values()].find(item => item.channelId === this.state.channelId);
    if (!pending) return;
    this.captionInFlight = true;
    let delay = 100;
    void chatRequest('call:caption', pending).then(() => {
      this.pendingCaptions.delete(pending.segmentId);
    }).catch(cause => {
      delay = 3000;
      this.emit({ error: cause instanceof Error ? cause.message : 'Caption sharing interrupted.' });
    }).finally(() => {
      this.captionInFlight = false;
      if (this.pendingCaptions.size && !this.retryTimer && this.state.captionsOn) this.retryTimer = setTimeout(() => {
        this.retryTimer = null; this.flushCaptions();
      }, delay);
    });
  }

  private addCaption(id: string, sid: string, userId: string, timestamp: string, username: string, text: string, final: boolean) {
    const captions = [...this.state.captions];
    const index = captions.findIndex(item => item.id === id && item.userId === userId);
    if (index >= 0 && captions[index].final) return;
    const line = { id, sid, userId, timestamp, username, text, final };
    if (index >= 0) captions[index] = line;
    else captions.push(line);
    this.emit({ captions: captions.slice(-100) });
  }

  /** Live captions: the browser transcribes your microphone and shares the words with the call. */
  toggleCaptions(username: string) {
    if (this.state.muted && !this.recognition) { this.emit({ error: 'Unmute your microphone before enabling transcription.' }); return; }
    if (this.recognition) { this.stopCaptions(); return; }
    const Speech = recognitionClass();
    if (!Speech) { this.emit({ error: 'Live captions need Chrome or Edge on a computer.' }); return; }
    const recognition = new Speech();
    recognition.lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = event => {
      const channelId = this.state.channelId;
      this.recognitionFailures = 0;
      if (!channelId || this.state.muted || Date.now() < this.disclosureUntil || isAnnouncing()) return;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const text = result[0]?.transcript.trim();
        if (!text || this.captionResults.get(index) === `final:${text}`) continue;
        const parts = captionParts(text);
        const share = result.isFinal || Date.now() - this.lastInterim >= 400;
        if (share) { this.lastInterim = Date.now(); this.captionResults.set(index, `${result.isFinal ? 'final' : 'interim'}:${text}`); }
        parts.forEach((part, partIndex) => {
          const segmentId = `${this.captionEpoch}_${index}_${partIndex}`;
          this.addCaption(segmentId, socket.id ?? 'me', currentUserId() ?? '', new Date().toISOString(), username, part, result.isFinal);
          if (share && result.isFinal) {
            if (this.pendingCaptions.size >= 1000) {
              this.emit({ error: 'Caption sharing has been interrupted for too long. Reconnect to continue sharing speech.' });
              return;
            }
            this.pendingCaptions.set(segmentId, { channelId, segmentId, text: part, final: true });
          } else if (share && socket.connected) {
            void chatRequest('call:caption', { channelId, segmentId, text: part, final: false }).catch(() => {});
          }
        });
        this.flushCaptions();
      }
    };
    recognition.onerror = event => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
        this.stopCaptions(); this.emit({ error: 'Transcription needs access to an available microphone.' });
      } else this.recognitionFailures += 1;
    };
    recognition.onend = () => {
      if (this.recognition !== recognition || !this.state.channelId) return;
      if (isAnnouncing()) return;
      this.restartRecognition(recognition, Math.min(10000, 650 * 2 ** Math.min(6, this.recognitionFailures)));
    };
    this.recognition = recognition;
    this.captionEpoch = crypto.randomUUID(); this.captionResults.clear();
    void chatRequest('call:state', { channelId: this.state.channelId, captions: true }).then(() => {
      if (this.recognition !== recognition) return;
      try { this.emit({ captionsOn: true }); playSound('captions_start'); if (!isAnnouncing()) this.restartRecognition(recognition, Math.max(650, this.disclosureUntil - Date.now())); } catch { this.stopCaptions(); }
    }).catch(cause => { this.stopCaptions(); this.emit({ error: cause instanceof Error ? cause.message : 'Transcription could not be enabled.' }); });
  }

  private restartRecognition(recognition: Recognition, delay: number) {
    if (this.recognitionRestart) clearTimeout(this.recognitionRestart);
    this.recognitionRestart = setTimeout(() => {
      this.recognitionRestart = null;
      if (this.recognition !== recognition || !this.state.channelId || isAnnouncing()) return;
      try { this.captionEpoch = crypto.randomUUID(); this.captionResults.clear(); recognition.start(); }
      catch { this.stopCaptions(); }
    }, delay);
  }

  private stopCaptions() {
    const recognition = this.recognition;
    this.recognition = null;
    if (this.recognitionRestart) clearTimeout(this.recognitionRestart);
    this.recognitionRestart = null;
    this.pendingCaptions.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.state.channelId && socket.connected) void chatRequest('call:state', { channelId: this.state.channelId, captions: false }).catch(() => {});
    try { recognition?.stop(); } catch { /* already stopped */ }
    if (this.state.captionsOn) playSound('captions_stop');
    this.emit({ captionsOn: false });
  }

  private hangUp() {
    if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
    stopHuddleAudio();
    if (this.outgoingInvitation) void chatRequest('call:respond', { invitationId: this.outgoingInvitation, action: 'cancelled' }).catch(() => {});
    this.outgoingInvitation = null;
    this.stopCaptions();
    this.resetLinks();
    this.stopTracks();
    this.peers.clear();
    this.queued = [];
  }

  async ring(channelId: string) {
    const result = await chatRequest<{ invitationId: string; expiresAt: number }>('call:ring', { channelId });
    if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
    this.outgoingTimeout = setTimeout(() => { if (this.outgoingInvitation === result.invitationId) { this.outgoingInvitation = null; this.emit({ outgoing: false }); stopRing(result.invitationId); playSound('unanswered', undefined, `resolved:${result.invitationId}`); } }, Math.max(0, result.expiresAt - Date.now()));
    this.outgoingInvitation = result.invitationId; this.emit({ outgoing: true }); startRing(result.invitationId, true, result.expiresAt);
  }

  cancelRinging() {
    if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
    stopRing();
    if (this.outgoingInvitation) void chatRequest('call:respond', { invitationId: this.outgoingInvitation, action: 'cancelled' }).catch(() => {});
    this.outgoingInvitation = null; this.emit({ outgoing: false });
  }

  toggleMute() {
    if (!this.audio) return;
    const muted = !this.state.muted;
    this.audio.enabled = !muted;
    if (muted && this.recognition) this.stopCaptions();
    playSound(muted ? 'microphone_mute' : 'microphone_on', 'huddles');
    this.emit({ muted });
    this.sendState();
  }

  async toggleCamera() {
    const wasOn = this.state.camera;
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
    if (wasOn !== this.state.camera) playSound(this.state.camera ? 'camera_on' : 'camera_off', 'huddles');
    this.sendState();
  }

  async toggleScreen() {
    const wasSharing = this.state.screen;
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
    if (wasSharing !== this.state.screen) playSound(this.state.screen ? 'screen_on' : 'screen_off', 'huddles');
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
    if (channelId) void chatRequest('call:state', { channelId, muted, camera, screen, hand: this.state.hand, captions: this.state.captionsOn }).catch(() => {});
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
    let lastVoice = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) sum += (value - 128) ** 2;
      const muted = key === 'local' ? this.state.muted : this.peers.get(key)?.muted;
      if (!muted && Math.sqrt(sum / samples.length) > 6) lastVoice = Date.now();
      const speaking = !muted && Date.now() - lastVoice < 500;
      if (key === 'local') { if (speaking !== this.state.speaking) this.emit({ speaking }); return; }
      const peer = this.peers.get(key);
      if (peer && peer.speaking !== speaking) { this.peers.set(key, { ...peer, speaking }); this.emit(); }
    }, 200);
    this.meters.set(key, () => { clearInterval(timer); source.disconnect(); });
  }
}

export const calls = new CallManager();
