# Huddle reliability

## Findings and implementation

### Shared transcription

The previous browser recognizer captured one local microphone per consenting browser, not remote WebRTC streams. Two caption toggles did not prove that both recognition engines were running. Stopping capture discarded pending text before asynchronous final results arrived. Privacy announcement handling stopped recognition and dropped results during a fixed suppression window. Enabling capture while an announcement was already playing could leave recognition permanently paused. The transcript had no durable meeting identity or replay protocol; server restart/disconnection could split a meeting. AI notes could fall back to text chat and an editable transcript document.

Each consenting participant now owns one capture pipeline, guarded by a server-side per-user microphone lease. Caption visibility is separate from microphone transcription. The controller processes every recognition result, revises interim segments in place, gives final segments stable IDs, and retries finalized text until a canonical server acknowledgment arrives. Unacknowledged browser text is stored in account/session-scoped sessionStorage for at most 24 hours and cleared on logout. Audio is never written there. Stop waits for asynchronous results and delivery. A second explicit Leave permits ending with an incomplete-transcript warning when delivery cannot finish.

PostgreSQL meeting IDs, participants, consent history, sequence/revision metadata, immutable finalized segments and capture interruption reasons survive ephemeral socket state. Authenticated identity supplies speaker attribution. Participant-only transcript APIs support pagination; live recovery returns the latest 500 segments. AI summaries read all finalized database segments, reject oversized input rather than silently truncate it, never substitute chat messages, and report capture limitations. Raw transcripts and AI notes are explicitly different features. New transcript Docs require meeting participation as well as current channel access.

Browser recognition remains probabilistic and has browser/language/input limitations. Passing the selected audio track uses the browser's supported SpeechRecognition API; unsupported implementations can still use their default microphone. English and Urdu can be selected. Automatic mixed-language capture requires the optional private worker. No perfect accuracy claim is made.

### Calling lifecycle

Route effects in the global dock, navigation and Home canceled invitations or stopped ringtones. Incoming notifications depended on temporary event state, disappeared on disconnect, and had no authoritative snapshot. Redis-only invitations expired without durable missed-call records. A join acknowledgment was treated as a connected call before WebRTC connectivity.

Invitations now persist in PostgreSQL with row-locked transitions, versions, expiration, recipient declines, accepted device and connection timestamps. The client subscribes globally and recovers snapshots after reconnect and periodically. A compact incoming/outgoing interface shows identity, ringing/connecting state and explicit actions. Ringtone lifetime follows pending server state and its deadline; route changes do not cancel it. Acceptance reserves one receiving socket, and reciprocal media-ready reports distinguish signaling acceptance from a connected peer connection. Unanswered invitations produce deduplicated missed-Huddle inbox records with caller and invitation time. Availability is checked before invitation creation and again at acceptance. Channel Huddles do not automatically ring all channel members.

Externally visible states are ringing, accepted, connecting, connected, declined, cancelled, expired and ended. Creation is the initiation event; an expired invitation produces the separate missed notification. Existing event aliases remain for compatibility.

### Navigation and media

The root-level Huddle host remains the sole audio/UI owner. Route effects now minimize presentation only. Stable remote MediaStream objects prevent unnecessary audio element replacement. Remote playback retries after interaction and exposes a Resume Huddle audio control if blocked. Huddle duration derives from the durable server start timestamp. Media status follows peer connection state, and early ICE candidates queue until a remote description exists. Transient authentication refresh errors retain media identity; actual authentication rejection still logs out. Unexpected final disconnection starts a configurable reconnect grace period rather than immediately finishing the meeting. Full refresh and closed-browser continuity are not promised.

## APIs and events

| Interface | Behavior |
|---|---|
| GET /api/calls/invitations?history=false | Authorized active invitation recovery; history includes resolved rows |
| GET /api/calls/transcription | Public capability information for authenticated clients; no worker credential |
| GET /api/calls/sessions/{id}/transcript?offset=0&limit=500 | Participant-only finalized transcript, coverage and nextOffset |
| POST /api/calls/sessions/{id}/audio | Optional exact-track WAV processing with authenticated socket/consent ownership |
| call:invitation | Versioned authoritative invitation transition |
| call:respond | Accept, decline or cancel; device reservation and permissions enforced |
| call:join | Returns sessionId, startedAt, transcript replay and coverage; accepts invitationId |
| call:caption | Session, authenticated speaker, stable segmentId, sequence, revision, timestamp, final |
| call:transcript-sync | Current participant-only snapshot for reconnect/lost events |
| call:capture-state | Capture lifecycle/interruption state and bounded final-result drain permission |
| call:media-ready | Reciprocal connected peer reports, separate from join acknowledgment |
| notification:new | Existing notification pipeline includes missed_huddle |

Existing call:incoming, call:resolved, call:state, call:signal and disclosure events remain supported. No recording or AI-enabled announcement is emitted for ordinary microphone transcription.

## Database and deployment

Migration 83dae2b627af adds huddle_sessions, huddle_members, huddle_invitations, session/sequence/revision metadata on existing huddle_segments, Huddle links on messages and Docs, and a deduplicated notification source-call reference. Migration ee76345206c0 adds worker capture cursors. Both are additive; existing users, messages and legacy transcript rows remain. The existing Render backend build applies Alembic migrations. Do not downgrade through these migrations as a routine rollback because their new tables contain meeting data; roll back application code while retaining the expanded schema.

Optional settings (safe defaults preserve existing deployment):

- CALL_INVITATION_SECONDS=45 (15?180)
- CALL_RECONNECT_GRACE_SECONDS=90 (15?300)
- TRANSCRIPTION_URL and TRANSCRIPTION_TOKEN unset: browser recognition

The current deployment does not automatically provision a speech worker or purchase compute. Do not put TRANSCRIPTION_TOKEN in NEXT_PUBLIC variables. Never point the worker URL at a user-supplied endpoint.

## Optional self-hosted speech worker

This path uses the selected consenting microphone only: AudioWorklet produces mono 16 kHz PCM in overlapping five-second windows, the authenticated API validates WAV data and ownership, and a private CPU faster-whisper worker returns word timestamps. Durable per-run cursors suppress overlapping/replayed words. Committed text shares the same final-segment persistence and broadcast path. Audio stays in a bounded RAM queue and is discarded after acknowledgment. Capture pauses and reports an error when inference falls behind. Privacy announcements pause capture; speech during those pauses is explicitly unavailable. It is never mixed intentionally into the capture stream.

1. Use an operator-owned host with measured CPU/RAM capacity and private connectivity to the API. Keep it separate from the constrained API process.
2. Create a Python 3.12 virtual environment in services/speech and install requirements.txt.
3. Configure TRANSCRIPTION_TOKEN with a random private value on both API and worker. Set WHISPER_MODEL to a local compatible model directory or a supported multilingual model identifier (default small). Keep model files cached persistently and allow initial model download before traffic.
4. Start `python -m uvicorn main:app --host 0.0.0.0 --port 8100` from services/speech behind a private network or authenticated TLS reverse proxy. Readiness stays unavailable until the model loads. Do not expose an unauthenticated worker publicly.
5. Set the API's TRANSCRIPTION_URL to that private origin and restart the API. Confirm authenticated /api/calls/transcription returns self_hosted without credentials.
6. Load-test two, three and five independent microphones. Inference must keep up with one window per participant every four seconds. If not, increase measured capacity or use a more suitable model/streaming engine; do not conceal dropped capture or purchase compute automatically.
7. Verify English, Urdu and mixed-language speech on real microphones before enabling for general meetings. Five-second window recognition can add latency and make boundary/word-timestamp errors. VAD/model errors and acoustic speaker feedback remain possible.

The worker API integration is covered using deterministic inference responses. Actual model inference, production throughput and physical-device multilingual accuracy require operator verification. The worker is optional, disabled by default and is not represented as an already operational production transcription service.

Technical references: [SpeechRecognition.start](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start), [faster-whisper documentation and MIT license](https://github.com/SYSTRAN/faster-whisper). Keep the chosen model's own license with its deployment. No new notification audio assets or paid services are introduced by this change.

## Manual acceptance checklist

Use independent accounts and preferably separate physical devices with headphones. A synthetic recognizer test verifies transport and lifecycle, not recognition accuracy.

1. Start a direct Huddle while the receiver is on Feed. Verify visible ringing, caller identity, outgoing tone and repeated incoming ringtone. Navigate both users while ringing. Accept, decline, cancel and let separate invitations expire; all devices must stop ringing and missed calls must appear once.
2. Repeat with a second receiver tab, reconnecting receiver, offline receiver, simultaneous invitations and restrictive availability. One device can reserve acceptance; rejected availability must not show a successful ring. Closed-browser incoming calls are not claimed by this change.
3. Join with two, then three and five accounts. Each person explicitly enables their own microphone transcription and chooses the language. Speak distinct scripted sentences containing names, decisions, responsibilities and deadlines; compare the actual speech with captions and the final transcript. Record omissions and recognition errors.
4. Hide/show captions independently of transcription. Mute/unmute, change microphones, interrupt networking, reconnect, and stop transcription during the last sentence. Confirm stable speaker identities and no duplicate finalized segments. Consent withdrawal must stop further capture, while already captured final speech drains within its limited authorization window.
5. While speaking continuously, navigate through Home, Feed, Explore, direct conversations, Tasks, Files, Activity, Settings, communities and profiles; minimize/expand repeatedly. Confirm audible remote speech, microphone transmission, stable session identity/timer and no unnecessary leave/join sounds or extra connections.
6. Finish cleanly, open the raw transcript and separately generate AI notes. Compare both against each consenting participant's actual contribution. Missing capture must be disclosed; no invented details or unrelated chat may appear. A nonparticipant channel member must not read the transcript or generate its notes.
7. Revoke access, log out, lose/recover the network and restart the API. Confirm resource release, truthful connection states, invitation recovery and incomplete-capture disclosures. Full reload interrupts the media connection and is a separate case.
8. Repeat on desktop Chrome/Edge, supported Safari/mobile browsers, light/dark themes and narrow screens. Actual microphone, mobile background behavior, subjective sound quality and multi-device ASR accuracy remain unverified until this checklist is completed.

## Verification record

Automated check results and deployment state are recorded below after the release checks finish. No real speech accuracy result is implied by deterministic test recognition.

## Files in this release

- `apps/server/.env.example`
- `apps/server/alembic/versions/83dae2b627af_durable_huddle_sessions_invitations_and_.py`
- `apps/server/alembic/versions/ee76345206c0_persist_speech_worker_capture_cursors.py`
- `apps/server/app/ai/service.py`
- `apps/server/app/calls/invitations.py`
- `apps/server/app/calls/router.py`
- `apps/server/app/calls/schemas.py`
- `apps/server/app/calls/service.py`
- `apps/server/app/calls/sessions.py`
- `apps/server/app/calls/speech.py`
- `apps/server/app/calls/transcripts.py`
- `apps/server/app/core/config.py`
- `apps/server/app/db/models.py`
- `apps/server/app/docs/service.py`
- `apps/server/app/notifications/schemas.py`
- `apps/server/app/notifications/service.py`
- `apps/server/app/realtime/socket.py`
- `apps/server/app/scheduler.py`
- `apps/server/tests/helpers.py`
- `apps/server/tests/test_ai.py`
- `apps/server/tests/test_audio_events.py`
- `apps/server/tests/test_calls.py`
- `apps/server/tests/test_huddle_reliability.py`
- `apps/server/tests/test_speech_worker.py`
- `apps/web/e2e/fixtures.ts`
- `apps/web/e2e/huddle-audio.spec.ts`
- `apps/web/package.json`
- `apps/web/public/worklets/huddle-pcm.js`
- `apps/web/src/app/home/page.tsx`
- `apps/web/src/components/ai/huddle-notes.tsx`
- `apps/web/src/components/call/call-bar.tsx`
- `apps/web/src/components/call/call-dock.tsx`
- `apps/web/src/components/call/call-stage.tsx`
- `apps/web/src/components/call/call-timer.ts`
- `apps/web/src/components/call/global-call-dock.tsx`
- `apps/web/src/components/call/huddle-button.tsx`
- `apps/web/src/components/call/incoming-call.tsx`
- `apps/web/src/components/inbox/inbox-view.tsx`
- `apps/web/src/components/nav.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/lib/call-invitations.ts`
- `apps/web/src/lib/call.ts`
- `apps/web/src/lib/notifications.ts`
- `apps/web/src/lib/pcm-transcription.ts`
- `apps/web/src/lib/transcription.ts`
- `apps/web/src/lib/use-call.ts`
- `apps/web/test/api-session.test.cjs`
- `apps/web/test/pcm.test.cjs`
- `apps/web/test/transcription.test.cjs`
- `docs/huddle-reliability.md`
- `packages/shared/src/schemas/notifications.ts`
- `services/speech/main.py`
- `services/speech/requirements.txt`
