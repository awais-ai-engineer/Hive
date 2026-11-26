'use client';

import { PcmCapture } from './pcm-transcription';
import { SpeechCapture, recognitionClass, type TranscriptSegment } from './transcription';
import { announceSound, isAnnouncing, onAnnouncement, playSound, stopRing, stopHuddleAudio, type SoundEvent } from './sounds';
import { apiFetch, responseData, currentUserId, subscribeSession } from './api';
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

export type Caption = { id: string; sid: string; userId: string; timestamp: string; username: string; text: string; final: boolean; sessionId?: string | null; sequence?: number; revision?: number };
export type Reaction = { id: string; sid: string; emoji: string };
export const REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const;

export type CallState = {
  channelId: string | null;
  /** Name of the place the call is in, shown in the call bar while you browse elsewhere. */
  title: string;
  /** Whether the floating participant tiles are open. */
  stageOpen: boolean;
  status: 'idle' | 'joining' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  sessionId: string | null; startedAt: string | null;
  captionsVisible: boolean; captureState: string; language: string;
  coverage: { userId: string; name: string; consented: boolean; state: string; incompleteReason?: string | null }[];
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
  audioSender: RTCRtpSender | null; videoSender: RTCRtpSender | null; pendingCandidates: RTCIceCandidateInit[];
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
  channelId: null, sessionId: null, startedAt: null, captionsVisible: true, captureState: 'inactive', language: 'en-US', coverage: [], title: '', stageOpen: false, status: 'idle', error: '', muted: false, camera: false, screen: false,
  localStream: null, speaking: false, peers: [], hand: false, captionsOn: false, captions: [], reactions: [], disclosure: '', outgoing: false,
};

export const captionsSupported = () => !!recognitionClass() || typeof AudioWorkletNode !== 'undefined';

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
  private capture: SpeechCapture | PcmCapture | null = null;
  private captureName = '';
  private announcementResume: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private warnedLeave = false;
  private joining = false;
  private reconnecting = false;
  private disclosedMeetings = new Set<string>();
  private queuedCaptions: (Caption & { segmentId: string })[] = [];
  private outgoingInvitation: string | null = null;
  private outgoingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    onAnnouncement(playing => {
      if (this.announcementResume) clearTimeout(this.announcementResume);
      if (playing) this.capture?.pause('Capture paused during a mandatory privacy disclosure; speech during playback is unavailable.');
      else this.announcementResume = setTimeout(() => { if (!this.state.muted) this.capture?.resume(); }, 350);
    });
    socket.on('call:disclosure', (data: { channelId: string; event: SoundEvent; id: string }) => {
      if (data.channelId !== this.state.channelId || !['transcription_started', 'transcription_stopped'].includes(data.event)) return;
      if (data.event === 'transcription_started') this.disclosedMeetings.add(data.id.split(':')[2]);
      this.emit({ disclosure: data.event === 'transcription_started' ? 'Speech transcription is active. Finalized speech is saved as a raw transcript for meeting participants.' : 'Speech transcription has stopped.' });
      announceSound(data.event, data.id);
    });
    socket.on('call:resolved', (data: { invitationId: string; status: string }) => {
      if (data.status !== 'ringing' || (data as { declined?: string[] }).declined?.includes(currentUserId() ?? '')) stopRing(data.invitationId, true);
      if (data.invitationId !== this.outgoingInvitation || data.status === 'ringing') return;
      if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
      this.outgoingInvitation = null; this.emit({ outgoing: false });
      if (data.status === 'declined' || data.status === 'expired') playSound(data.status === 'declined' ? 'declined' : 'unanswered', 'huddles', `resolved:${data.invitationId}`);
    });
    let ownerId = currentUserId();
    subscribeSession(session => {
      if (session?.user.id !== ownerId) { this.disclosedMeetings.clear(); if (this.state.channelId) { this.hangUp(true); this.emit({ ...idle }); } }
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
    socket.on('call:caption', (data: Caption & { channelId: string; segmentId: string }) => {
      if (data.channelId !== this.state.channelId) return;
      if (!this.state.sessionId) { this.queuedCaptions.push(data); return; }
      this.mergeCaption(data);
    });
    socket.on('call:capture-state', (data: { sessionId: string; userId: string; state: string }) => {
      if (data.sessionId === this.state.sessionId) this.emit({ coverage: this.state.coverage.map(person => person.userId === data.userId ? { ...person, state: data.state } : person) });
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
    socket.on('disconnect', () => { if (this.state.channelId) { this.emit({ status: 'reconnecting' }); playSound('connection_lost', 'huddles'); this.captureStatus('offline', 'Signaling disconnected; finalized captions are buffered on this device.'); } });
    socket.on('connect', () => {
      const channelId = this.state.channelId;
      if (channelId && ['reconnecting', 'error'].includes(this.state.status)) { this.reconnecting = true; this.resetLinks(); this.emit({ status: 'reconnecting' }); void this.joinNow(channelId, this.state.title); }
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

  async join(channelId: string, title = '', invitationId?: string) {
    if (this.state.channelId === channelId && !['idle', 'error', 'reconnecting'].includes(this.state.status)) return;
    const choice = this.beforeJoin ? await this.beforeJoin(channelId, title) : { muted: false, camera: false };
    if (!choice) return;
    if (invitationId) await chatRequest('call:respond', { invitationId, action: 'accepted' });
    await this.joinNow(channelId, title, invitationId);
    if (!['waiting', 'connecting', 'connected'].includes(this.state.status)) return;
    if (choice.muted && !this.state.muted) this.toggleMute();
    if (choice.camera && !this.state.camera) await this.toggleCamera();
  }

  /** Joins without the pre-join screen (reconnects and confirmed joins). */
  async joinNow(channelId: string, title = '', invitationId?: string) {
    if (this.state.channelId === channelId && !['idle', 'error', 'reconnecting'].includes(this.state.status)) return;
    if (this.joining) return;
    if (this.state.channelId && this.state.channelId !== channelId && !await this.leave()) return;
    this.joining = true;
    this.emit({ channelId, title, status: 'joining', error: '' });
    void this.audioContext?.resume().catch(() => {});
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
      const result = await chatRequest<{ iceServers: RTCIceServer[]; peers: Omit<Peer, 'stream' | 'speaking'>[]; transcription: { active: boolean; meetingId: string }; sessionId: string; startedAt: string; transcript: (Caption & { segmentId: string })[]; coverage: CallState['coverage'] }>(
        'call:join', { channelId, invitationId });
      if (this.state.sessionId && this.state.sessionId !== result.sessionId) { this.capture?.dispose(); this.capture = null; this.emit({ captionsOn: false, captions: [], coverage: [] }); }
      this.emit({ sessionId: result.sessionId, startedAt: result.startedAt, coverage: result.coverage ?? [] });
      for (const segment of [...(result.transcript ?? []), ...this.queuedCaptions.splice(0)]) this.mergeCaption(segment);
      this.iceServers = result.iceServers;
      for (const peer of result.peers) this.peers.set(peer.sid, { ...peer, stream: null, speaking: false });
      this.updateLocalStream();
      for (const peer of result.peers) this.connect(peer.sid);
      this.emit({ status: result.peers.length ? 'connecting' : 'waiting' });
      stopRing();
      playSound(this.reconnecting ? 'reconnection' : 'huddle_start', 'huddles'); this.reconnecting = false;
      if (result.transcription?.active && !this.disclosedMeetings.has(result.transcription.meetingId)) {
        this.disclosedMeetings.add(result.transcription.meetingId);
        this.emit({ disclosure: 'Speech transcription is active. Finalized speech is saved as a raw transcript for meeting participants.' });
        announceSound('transcription_active', `transcription-active:${channelId}:${result.transcription.meetingId}:${currentUserId()}`);
      }
      for (const [from, signal] of this.queued.splice(0)) void this.onSignal(from, signal);
      await chatRequest('call:state', { channelId, muted: this.state.muted || !this.audio, camera: this.state.camera, screen: this.state.screen, hand: this.state.hand, captions: this.state.captionsOn }).catch(cause => { this.capture?.pause('Transcription state could not be synchronized'); this.emit({ error: cause instanceof Error ? cause.message : 'Huddle state could not be synchronized.' }); });
      this.capture?.flush();
      if (this.syncTimer) clearInterval(this.syncTimer);
      this.syncTimer = setInterval(() => void this.syncTranscript(), 10000);
    } catch (cause) {
      this.hangUp();
      this.emit({ ...idle, status: 'error', error: cause instanceof Error ? cause.message : 'Could not join the huddle.' });
    } finally { this.joining = false; }
  }

  async leave() {
    const channelId = this.state.channelId;
    const drained = await this.stopTranscription();
    if (!drained && !this.warnedLeave) { this.warnedLeave = true; this.emit({ error: 'Finalized captions have not synchronized. Reconnect to save them, or press Leave again to end with an incomplete transcript.' }); return false; }
    if (channelId && socket.connected) await chatRequest('call:leave', { channelId }).catch(() => {});
    this.hangUp(); this.emit({ ...idle }); this.warnedLeave = false;
    playSound('huddle_end', 'huddles'); return true;
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

  private mergeCaption(data: Caption & { segmentId: string }) {
    this.addCaption(data.segmentId, data.sid ?? '', data.userId, data.timestamp, data.username, data.text, data.final, data.sequence, data.revision, data.sessionId);
  }
  private addCaption(id: string, sid: string, userId: string, timestamp: string, username: string, text: string, final: boolean, sequence = 0, revision = 0, sessionId = this.state.sessionId) {
    if (sessionId && sessionId !== this.state.sessionId) return;
    const captions = [...this.state.captions]; const index = captions.findIndex(item => item.id === id && item.userId === userId);
    if (index >= 0 && ((captions[index].final && !final) || (captions[index].revision ?? 0) > revision)) return;
    const line = { id, sid, userId, timestamp, username, text, final, sessionId, sequence, revision };
    if (index >= 0) captions[index] = line; else captions.push(line);
    captions.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (a.sequence ?? 0) - (b.sequence ?? 0));
    this.emit({ captions: captions.slice(-500) });
  }
  private async syncTranscript() {
    if (!this.state.channelId || !socket.connected) return;
    try {
      const result = await chatRequest<{ sessionId: string; segments: (Caption & { segmentId: string })[]; coverage: CallState['coverage'] }>('call:transcript-sync', { channelId: this.state.channelId });
      if (result.sessionId !== this.state.sessionId) return;
      result.segments.forEach(segment => this.mergeCaption(segment)); this.emit({ coverage: result.coverage }); this.capture?.flush();
    } catch { /* reconnection restores replay; never clear captions on a failed refresh */ }
  }
  private captureStatus(state: string, reason?: string) {
    const failed = state === 'failed';
    this.emit({ captureState: failed ? 'error' : state, ...(reason && ['error', 'failed', 'interrupted'].includes(state) ? { error: reason } : {}) });
    // A fatal recognizer error must not leave the participant advertised as
    // transcribing. Transient interruptions retain consent for a safe retry.
    if (failed && this.state.captionsOn) {
      this.emit({ captionsOn: false });
      if (this.state.channelId && socket.connected) void chatRequest('call:state', { channelId: this.state.channelId, captions: false }).catch(() => {});
    }
    if (this.state.channelId && this.state.sessionId && socket.connected) void chatRequest('call:capture-state', { channelId: this.state.channelId, sessionId: this.state.sessionId, state, reason }).catch(() => {});
  }
  setCaptionsVisible() { this.emit({ captionsVisible: !this.state.captionsVisible }); }
  setLanguage(language: string) { if (!['en-US', 'ur-PK', 'auto'].includes(language)) return; this.emit({ language }); this.capture?.restart(); }
  async toggleTranscription(username: string) {
    if (this.state.captionsOn) { await this.stopTranscription(); return; }
    if (!this.state.channelId || !this.state.sessionId || this.state.muted) { this.emit({ error: 'Join and unmute before starting microphone transcription.' }); return; }
    try {
      const configuration = await responseData<{ engine: string }>(await apiFetch('/api/calls/transcription'));
      if (configuration.engine === 'browser' && !recognitionClass()) { this.emit({ error: 'Browser recognition is unavailable. An operator must configure the self-hosted speech worker for this browser.' }); return; }
      if (configuration.engine === 'browser' && this.state.language === 'auto') { this.emit({ error: 'Mixed-language automatic recognition requires the self-hosted speech worker. Select English or Urdu for browser recognition.' }); return; }
      await chatRequest('call:state', { channelId: this.state.channelId, captions: true });
      this.captureName = username;
      const channelId = this.state.channelId; const sessionId = this.state.sessionId;
      if (!this.capture && configuration.engine === 'self_hosted') this.capture = new PcmCapture({ channelId, sessionId,
        track: () => this.audio, language: () => this.state.language,
        connected: () => socket.connected && this.state.sessionId === sessionId,
        local: segment => this.mergeCaption(segment), status: (state, reason) => this.captureStatus(state, reason) });
      this.capture ??= new SpeechCapture({ userId: currentUserId() ?? '', channelId, sessionId,
        track: () => this.audio, language: () => this.state.language, connected: () => socket.connected && this.state.sessionId === sessionId,
        local: segment => this.addCaption(segment.segmentId, socket.id ?? '', currentUserId() ?? '', new Date().toISOString(), this.captureName, segment.text, false, segment.sequence, segment.revision, sessionId),
        send: async (segment: TranscriptSegment) => {
          const result = await chatRequest<{ segment?: Caption & { segmentId: string } }>('call:caption', segment);
          if (segment.final && !result.segment) throw new Error('The server did not acknowledge this finalized segment.');
          if (result.segment) this.mergeCaption(result.segment);
        }, status: (state, reason) => this.captureStatus(state, reason) });
      this.emit({ captionsOn: true });
      this.capture.start(isAnnouncing());
    } catch (cause) { this.emit({ error: cause instanceof Error ? cause.message : 'Transcription could not start.' }); }
  }
  toggleCaptions(username: string) { void this.toggleTranscription(username); }
  private async stopTranscription() {
    if (!this.capture) return true;
    const drained = await this.capture.stop();
    if (this.state.channelId && socket.connected) await chatRequest('call:state', { channelId: this.state.channelId, captions: false }).catch(() => {});
    this.emit({ captionsOn: false }); return drained;
  }

  private hangUp(clear = false) {
    if (this.syncTimer) clearInterval(this.syncTimer); this.syncTimer = null;
    if (this.announcementResume) clearTimeout(this.announcementResume);
    if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
    stopHuddleAudio();
    if (this.outgoingInvitation) void chatRequest('call:respond', { invitationId: this.outgoingInvitation, action: 'cancelled' }).catch(() => {});
    this.outgoingInvitation = null;
    this.capture?.dispose(clear); this.capture = null;
    this.resetLinks();
    this.stopTracks();
    this.peers.clear();
    this.queued = [];
  }

  async ring(channelId: string) {
    const result = await chatRequest<{ invitationId: string; expiresAt: number; caller: string; status: string }>('call:ring', { channelId });
    if (result.caller !== currentUserId() || result.status !== 'ringing') return;
    if (this.outgoingTimeout) clearTimeout(this.outgoingTimeout);
    this.outgoingTimeout = setTimeout(() => { if (this.outgoingInvitation === result.invitationId) { this.outgoingInvitation = null; this.emit({ outgoing: false }); stopRing(result.invitationId); playSound('unanswered', undefined, `resolved:${result.invitationId}`); } }, Math.max(0, result.expiresAt - Date.now()));
    this.outgoingInvitation = result.invitationId; this.emit({ outgoing: true });
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
    if (muted) this.capture?.pause('Microphone muted'); else this.capture?.resume();
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
    this.capture?.pause('Audio input changed');
    track.enabled = !this.state.muted;
    this.audio?.stop();
    this.audio = track;
    for (const link of this.links.values()) {
      if (link.audioSender) await link.audioSender.replaceTrack(track);
      else link.audioSender = link.pc.addTrack(track);
    }
    this.updateLocalStream();
    if (!this.state.muted) this.capture?.restart();
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
      videoSender: this.video ? pc.addTrack(this.video) : null, pendingCandidates: [],
    };
    this.links.set(sid, link);
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(sid, { description: pc.localDescription!.toJSON() });
      } catch { this.emit({ error: 'Media negotiation was interrupted; reconnecting.' }); pc.restartIce(); }
      finally { link.makingOffer = false; }
    };
    pc.onicecandidate = event => { if (event.candidate) this.signal(sid, { candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      link.stream.addTrack(event.track);
      event.track.onended = () => { link.stream.removeTrack(event.track); this.setPeerStream(sid, link.stream); };
      event.track.onunmute = () => this.setPeerStream(sid, link.stream);
      this.setPeerStream(sid, link.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.emit({ status: 'connected', error: '' });
        const peer = this.peers.get(sid);
        if (peer && this.state.channelId) void chatRequest('call:media-ready', { channelId: this.state.channelId, peerUserId: peer.userId }).catch(() => {});
      } else if (pc.connectionState === 'failed') { pc.restartIce(); this.emit({ status: 'reconnecting', error: 'A media connection failed; attempting ICE recovery.' }); }
      else if (pc.connectionState === 'disconnected' && ![...this.links.values()].some(item => item.pc.connectionState === 'connected')) this.emit({ status: 'reconnecting' });
    };
  }

  private setPeerStream(sid: string, stream: MediaStream) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    this.peers.set(sid, { ...peer, stream });
    this.meter(sid, stream);
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
        for (const queued of link.pendingCandidates.splice(0)) await link.pc.addIceCandidate(queued);
        if (description.type === 'offer') {
          await link.pc.setLocalDescription();
          this.signal(from, { description: link.pc.localDescription!.toJSON() });
        }
      } else if (candidate) {
        if (!link.pc.remoteDescription) { if (link.pendingCandidates.length < 256) link.pendingCandidates.push(candidate); return; }
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
