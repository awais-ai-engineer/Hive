# Hive audio experience

Development branch: `feature/professional-audio`. Listening approval and review are required before production deployment.

## Audit

Previously every event was rendered with two sine oscillators. Only category pitch and a broad regular expression distinguished events; even “unmute” matched “mute”. DMs and channels shared a cue. There were no voice assets or typed event registry. A global throttle could swallow important events, active oscillators could not be cancelled, and old ringtone timeouts could stop newer invitations. Decline was local UI state. Reconnection played before a successful rejoin. Previews temporarily changed global preferences, and notification handlers could overlap inbox and message events.

## Assets and provenance

39 original effects replace runtime oscillator synthesis. Felt mallets, damped glass partials, woody transients, filtered air, small reflections and soft envelopes form the family. Scores differ in articulation, instrumentation, rhythm and voicing; they are not pitch shifts of one beep. Source: `apps/web/scripts/render-sounds.py`. Effects are 24 kHz mono 16-bit PCM WAV, about 1.22 MB total. No proprietary recordings or third-party samples were used.

Seven speech assets were rendered offline with Piper 1.4.1 and en_US-ljspeech-medium, trained from scratch on the public-domain LJ Speech dataset. No paid TTS service, external playback URL, runtime TTS dependency or model is deployed. Model SHA-256: `6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`.

The complete inventories, durations, byte sizes and checksums are in `apps/web/public/sounds/v2/effects.json` and `announcements.json`. Licensing is in `LICENSE.txt`, with the original voice model card alongside it. Original effects and wording are CC0. The source describes the speech recordings as public domain in the United States; jurisdiction-specific distribution rights still apply.

- [Voice model and card](https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/medium)
- [LJ Speech dataset and rights](https://keithito.com/LJ-Speech-Dataset/)
- [Piper tool](https://github.com/OHF-Voice/piper1-gpl), a GPL-3.0 development tool, not an application dependency.

Reproduce effects with `python apps/web/scripts/render-sounds.py`. For speech, install `piper-tts==1.4.1` in an isolated development environment, download the named model and adjacent config, then run `python apps/web/scripts/render-announcements.py /path/to/en_US-ljspeech-medium.onnx`. Do not bundle the synthesis tools or model.

## Sound Manager

The shared typed catalogue defines category, priority, local/shared scope and gain. The call dock is mounted once in the authenticated app shell, so incoming invitations, remote audio, consent disclosures and compact controls remain available outside Home. Navigating between Home, Feed, Explore and settings does not recreate the communication session. The singleton manager decodes and caches bundled buffers, resumes after a gesture, catches missing-asset failures, cancels sources and owns ringtone intervals and exact expiry timers. Three common cues warm after interaction; other assets load on demand. Lower-priority overlap is suppressed, while mandatory disclosures queue and preempt ringtones. Notification output connects only to the local AudioContext destination and never to WebRTC tracks or screen sharing.

Stable event IDs deduplicate in memory and across tabs through Web Locks, bounded localStorage history and BroadcastChannel. Local controls remain local. Shared message IDs unify inbox and channel events. Incoming DMs and thread replies use authoritative inbox notifications; sent feedback follows successful delivery acknowledgement. The eight preference categories and individual switches use existing account JSONB storage, preserve legacy category choices and synchronize through `sounds:updated` plus the existing refresh. Previews do not change saved state. Logout clears playback and account state. The obsolete duplicate switch now links to the detailed controls.

Required disclosures override optional switches, muted categories, Quiet Hours and zero optional volume, retaining minimum gain and visible Huddle status. Autoplay still requires a user gesture: locked disclosures wait while the visual text appears immediately. Huddle teardown clears pending disclosures and ringtone loads.

## Authoritative Huddle events

`call:ring` returns one invitation ID and epoch expiry shared across devices. Redis stores a short-lived row, channel/caller indexes and an expiry sorted set. `call:respond` validates caller/recipient ownership; acceptance also requires joined Huddle membership and existing permissions. `call:resolved` communicates accepted, declined, cancelled and expired states. Joining through a deep link also resolves the invitation. One group recipient declining does not cancel the remaining invitations. Disconnect/leave cancels the caller's pending invitation; clients and the scheduler enforce expiry.

The server atomically derives aggregate transcription consent and versions real transitions. `call:disclosure` carries stable IDs and accurate transcription-started/stopped wording. Additional transcribers do not repeat the aggregate disclosure. Joining users receive active-state snapshots. Mini/expanded switches do not recreate the audio pipeline. Recognition pauses locally during speech output, ignores buffered results during playback and a short tail, and resumes without withdrawing consent. Echo cancellation and noise suppression are requested. Physical speaker feedback cannot be eliminated by application code; headphones are recommended.

Hive currently saves consented captions as transcript Docs and offers AI summarization afterward. It has no separate live AI-notes switch or audio/video meeting recorder. Their four voice assets are available for preview and reserved in the catalogue, but are not emitted for captions. Connecting those announcements requires the corresponding authoritative feature lifecycle and permissions in a separate change. No false recording or AI-state event was added.

## Notification integration

Optional audio respects account preferences, active conversations, conversation levels, muted spaces, availability suppression, Quiet Hours and Out of Office. Notification/call payloads carry server-computed audio eligibility separately from communication authorization. Existing availability enforcement still rejects blocked contact before delivery. Mandatory disclosures remain accessible.

Personal reminders, failed scheduled deliveries and new/reassigned tasks have event wiring. Targeted incoming workspace/community invitations, join requests, meeting scheduling/reminders, priority messages and dedicated new-member audio events do not currently exist in Hive. Their cues have assets and previews but are not attached to generic refresh events, which would produce misleading noise. No unrelated scheduling or community features were added.

## Verification and listening

Unit tests cover unique files, legacy preferences, in-flight deduplication, ringtone cancellation/replacement, priority, suppression, previews, unavailable files and logout. Backend tests use independent authenticated Socket.IO users and real PostgreSQL/Redis. Browser tests decode actual WAV files, exercise settings/save/reload/reset, mobile width and one-at-a-time previews. The optional real-API/WebRTC browser test uses two independent local accounts, synthetic microphones and a recognizer stub; it does not establish acoustic recognition accuracy.

Open `apps/web/public/sounds/v2/preview.html` directly, or visit `/sounds/v2/preview.html` on a local Hive server. Settings also offer every preview. Start at 35% volume and compare on headphones and laptop speakers:

- DM versus channel versus sent/failure; mention double chime and thread reply.
- Incoming ring versus outgoing wait; join/leave, mute/unmute and screen start/stop.
- Loudness consistency, fatigue, sharp transients, speech clarity and “AI” pronunciation in all seven sentences.
- Accept, decline, cancel and timeout across devices/tabs; group declines with a third account.
- One aggregate transcription start, one final stop, late join disclosure and no duplicate on minimize/reconnect.
- Speech during/after a disclosure, checking that announcement text does not enter saved transcripts. Speech while recognition is paused may be omitted.
- Optional silence under disabled categories/events, Quiet Hours, DND, Out of Office and muted conversations; required disclosure remains audible/visible.
- Preferences after reload, login and another device; denied permissions, network loss and background/foreground recovery.

Subjective listening approval, physical-device feedback testing, Safari/iOS and Android checks remain release gates. Chromium automation and waveform measurements cannot establish these results.

## Deployment and compatibility

No production merge/deployment or paid infrastructure is included. There are no database schema changes or new migrations: preferences use existing JSONB; invitations are ephemeral Redis state. API/event additions are compatible with old clients, which cannot use the new resolution/disclosure handling. After review, deploy the API before the frontend. An old backend version using strict preference validation must filter new JSON keys before rollback, or it cannot read expanded saved preferences.

Final test results, full event mapping and modified-file inventory follow below.

### Recorded validation

- 17 Sound Manager/asset tests passed; 25 shared-package tests passed.
- All 16 browser regressions passed, including settings persistence, actual WAV decoding, both themes/accessibility, mobile layout and the real local API/WebRTC test with two independent accounts and synthetic devices.
- 55 focused backend tests passed across calls, communication policy, tasks and notifications. A subsequent 31-test run covering the expanded audio cases, tasks and notifications also passed; these scopes overlap and must not be summed.
- Ruff, shared UI lint and Alembic drift validation passed. No new upgrade operations were detected; the existing ltree reflection warning is informational.
- Final production build, sequential type checking and complete backend-suite results are available in the pull request checks. Physical listening and Safari/mobile testing remain unverified.

## Complete asset and event map

Each row names a separate bundled file. Source is the original effects score, or the offline voice renderer for announcements.

| Asset | Meaning | Category | Scope | Integration |
|---|---|---|---|---|
| incoming.wav | Incoming direct message | messages | shared | Wired to existing events |
| channel_message.wav | Incoming channel message | messages | shared | Wired to existing events |
| message_sent.wav | Message delivered | messages | local | Wired to existing events |
| mention.wav | Mention or tag | mentions | shared | Wired to existing events |
| reply.wav | Thread reply | messages | shared | Wired to existing events |
| message_failed.wav | Message delivery failed | feedback | local | Wired to existing events |
| priority.wav | Priority notification | mentions | shared | Preview; no current producer |
| invitation.wav | Incoming Huddle invitation | huddles | shared | Wired to existing events |
| outgoing.wav | Calling | huddles | local | Wired to existing events |
| huddle_start.wav | Huddle connected | huddles | shared | Wired to existing events |
| huddle_end.wav | Huddle ended | huddles | shared | Wired to existing events |
| participant_join.wav | Participant joined | participants | shared | Wired to existing events |
| participant_leave.wav | Participant left | participants | shared | Wired to existing events |
| microphone_mute.wav | Microphone muted | controls | local | Wired to existing events |
| microphone_on.wav | Microphone unmuted | controls | local | Wired to existing events |
| camera_on.wav | Camera enabled | controls | local | Wired to existing events |
| camera_off.wav | Camera disabled | controls | local | Wired to existing events |
| hand_on.wav | Hand raised | participants | shared | Wired to existing events |
| hand_off.wav | Hand lowered | controls | local | Wired to existing events |
| screen_on.wav | Screen sharing started | controls | local | Wired to existing events |
| screen_off.wav | Screen sharing stopped | controls | local | Wired to existing events |
| connection_lost.wav | Connection lost | huddles | shared | Wired to existing events |
| reconnection.wav | Connection restored | huddles | shared | Wired to existing events |
| declined.wav | Invitation declined | huddles | shared | Wired to existing events |
| unanswered.wav | Invitation unanswered | huddles | shared | Wired to existing events |
| captions_start.wav | Live captions enabled | controls | local | Wired to existing events |
| captions_stop.wav | Live captions disabled | controls | local | Wired to existing events |
| workspace_invite.wav | Workspace invitation | activity | shared | Preview; no current producer |
| community_invite.wav | Community invitation | activity | shared | Preview; no current producer |
| invite_accepted.wav | Invitation accepted | activity | shared | Wired to existing events |
| join_request.wav | Community join request | activity | shared | Preview; no current producer |
| member_join.wav | New member | activity | shared | Preview; no current producer |
| task_assigned.wav | Task assigned | feedback | shared | Wired to existing events |
| meeting_reminder.wav | Meeting reminder | feedback | shared | Preview; no current producer |
| deadline.wav | Deadline reminder | feedback | shared | Wired to existing events |
| system.wav | Important system notification | feedback | shared | Preview; no current producer |
| success.wav | Significant action completed | feedback | local | Preview; no current producer |
| warning.wav | Warning | feedback | local | Preview; no current producer |
| error.wav | Error | feedback | local | Preview; no current producer |
| notes_enabled.wav | AI meeting notes are now enabled. | announcements | shared | Preview; no current producer |
| notes_stopped.wav | AI meeting notes have been stopped. | announcements | shared | Preview; no current producer |
| recording_started.wav | This meeting is now being recorded. | announcements | shared | Preview; no current producer |
| recording_stopped.wav | Meeting recording has stopped. | announcements | shared | Preview; no current producer |
| transcription_started.wav | Speech transcription is now enabled. Finalized captions will be saved as meeting notes. | announcements | shared | Wired to existing events |
| transcription_stopped.wav | Speech transcription has stopped. | announcements | shared | Wired to existing events |
| transcription_active.wav | Speech transcription is active in this Huddle. Finalized captions are saved as meeting notes. | announcements | shared | Wired to existing events |

## Modified and new files

- .github/workflows/ci.yml
- apps/server/app/availability/router.py
- apps/server/app/calls/audio.py
- apps/server/app/calls/invitations.py
- apps/server/app/calls/schemas.py
- apps/server/app/calls/service.py
- apps/server/app/notifications/service.py
- apps/server/app/realtime/socket.py
- apps/server/app/scheduler.py
- apps/server/app/tasks/router.py
- apps/server/tests/helpers.py
- apps/server/tests/test_audio_events.py
- apps/server/tests/test_calls.py
- apps/server/tests/test_communication_policy.py
- apps/web/e2e/huddle-audio.spec.ts
- apps/web/e2e/sounds.spec.ts
- apps/web/package.json
- apps/web/public/sounds/v2/LICENSE.txt
- apps/web/public/sounds/v2/announcements.json
- apps/web/public/sounds/v2/camera_off.wav
- apps/web/public/sounds/v2/camera_on.wav
- apps/web/public/sounds/v2/captions_start.wav
- apps/web/public/sounds/v2/captions_stop.wav
- apps/web/public/sounds/v2/channel_message.wav
- apps/web/public/sounds/v2/community_invite.wav
- apps/web/public/sounds/v2/connection_lost.wav
- apps/web/public/sounds/v2/deadline.wav
- apps/web/public/sounds/v2/declined.wav
- apps/web/public/sounds/v2/effects.json
- apps/web/public/sounds/v2/error.wav
- apps/web/public/sounds/v2/hand_off.wav
- apps/web/public/sounds/v2/hand_on.wav
- apps/web/public/sounds/v2/huddle_end.wav
- apps/web/public/sounds/v2/huddle_start.wav
- apps/web/public/sounds/v2/incoming.wav
- apps/web/public/sounds/v2/invitation.wav
- apps/web/public/sounds/v2/invite_accepted.wav
- apps/web/public/sounds/v2/join_request.wav
- apps/web/public/sounds/v2/meeting_reminder.wav
- apps/web/public/sounds/v2/member_join.wav
- apps/web/public/sounds/v2/mention.wav
- apps/web/public/sounds/v2/message_failed.wav
- apps/web/public/sounds/v2/message_sent.wav
- apps/web/public/sounds/v2/microphone_mute.wav
- apps/web/public/sounds/v2/microphone_on.wav
- apps/web/public/sounds/v2/notes_enabled.wav
- apps/web/public/sounds/v2/notes_stopped.wav
- apps/web/public/sounds/v2/outgoing.wav
- apps/web/public/sounds/v2/participant_join.wav
- apps/web/public/sounds/v2/participant_leave.wav
- apps/web/public/sounds/v2/preview.html
- apps/web/public/sounds/v2/priority.wav
- apps/web/public/sounds/v2/reconnection.wav
- apps/web/public/sounds/v2/recording_started.wav
- apps/web/public/sounds/v2/recording_stopped.wav
- apps/web/public/sounds/v2/reply.wav
- apps/web/public/sounds/v2/screen_off.wav
- apps/web/public/sounds/v2/screen_on.wav
- apps/web/public/sounds/v2/success.wav
- apps/web/public/sounds/v2/system.wav
- apps/web/public/sounds/v2/task_assigned.wav
- apps/web/public/sounds/v2/transcription_active.wav
- apps/web/public/sounds/v2/transcription_started.wav
- apps/web/public/sounds/v2/transcription_stopped.wav
- apps/web/public/sounds/v2/unanswered.wav
- apps/web/public/sounds/v2/voice-model-card.txt
- apps/web/public/sounds/v2/warning.wav
- apps/web/public/sounds/v2/workspace_invite.wav
- apps/web/scripts/render-announcements.py
- apps/web/scripts/render-sounds.py
- apps/web/src/app/layout.tsx
- apps/web/src/app/home/page.tsx
- apps/web/src/app/settings/page.tsx
- apps/web/src/components/call/global-call-dock.tsx
- apps/web/src/components/call/call-bar.tsx
- apps/web/src/components/call/call-stage.tsx
- apps/web/src/components/call/huddle-button.tsx
- apps/web/src/components/call/incoming-call.tsx
- apps/web/src/components/communication-settings.tsx
- apps/web/src/components/nav.tsx
- apps/web/src/components/sound-settings.tsx
- apps/web/src/lib/auth.tsx
- apps/web/src/lib/call.ts
- apps/web/src/lib/sounds.ts
- apps/web/src/lib/use-call.ts
- apps/web/test/sounds.test.cjs
- docs/audio-experience.md
- packages/shared/src/events.ts
- packages/shared/src/index.ts
- packages/shared/src/sounds.ts
