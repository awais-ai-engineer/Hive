# Hive

A real-time community platform: Reddit-style communities and feeds, Discord/Slack-style chat
with threads, WebRTC voice/video rooms, and an integrations API.

## Structure

```
apps/web/             Next.js frontend (port 3000)
apps/server/          Python backend: FastAPI + Socket.IO + SQLAlchemy/Alembic (port 4000)
services/moderation/  FastAPI toxicity/spam scoring (port 8000)
packages/shared/      TypeScript types and event names for the frontend
infra/                docker-compose (Postgres, Redis, moderation)
```

## Run locally

Requirements: Node 22+, pnpm 9, Python 3.12, uv, Docker Desktop.

```bash
pnpm install                                   # frontend packages
cd apps/server && python -m uv sync && cd ../..  # backend packages
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm --filter @hive/server db:migrate          # create database tables
pnpm --filter @hive/server db:seed             # add demo accounts and spaces
cd apps/server && python -m uv run uvicorn app.main:app --reload --reload-dir app --port 4000
cd apps/web && pnpm exec next dev --turbopack -p 3000
```

Moderation service (without Docker):

```bash
cd services/moderation
python -m uv run --no-project --with fastapi --with "uvicorn[standard]" uvicorn main:app --port 8000
```

Open http://localhost:3000. The status page should show every service as **up**.

| Service        | URL                              |
| -------------- | -------------------------------- |
| Web            | http://localhost:3000            |
| API health     | http://localhost:4000/api/health |
| API docs       | http://localhost:4000/docs       |
| Moderation     | http://localhost:8000/docs       |
| Postgres       | localhost:5434 (hive / hive)     |
| Redis          | localhost:6380                   |

Ports 5434 and 6380 avoid clashing with other local Postgres/Redis instances.

## Roadmap

1. [x] Auth (signup, login, refresh-token rotation), profiles
2. [x] Spaces, roles, invites, channels
3. [x] Real-time chat: idempotent send, optimistic UI, reconnect sync
4. [x] Threads, reactions, uploads, presence, unread counts
5. [x] Posts, voting, hot/top/new ranking
6. [x] Nested comments (ltree), public community pages
7. WebRTC voice/video, huddles
8. Webhooks, slash commands, OAuth bots
9. Search, notifications, moderation queue
10. Load tests, Playwright, polish

## Auth

Sign up at `/signup`, log in at `/login`, and edit your username at `/me`.
Passwords use Argon2id. The API returns a 15-minute HS256 JWT, kept only in
frontend memory and sent as a Bearer token. A 30-day opaque refresh token lives
in the `hive_refresh` HttpOnly, SameSite=Lax cookie scoped to `/api/auth`.
Only its SHA-256 hash is stored in Postgres. Refresh rotates the token within
its login family; replay revokes the entire family. Family operations are
serialized to prevent concurrent rotation from escaping reuse detection.
Signup and login allow 10 requests per IP per endpoint per minute using Redis.

Google sign-in uses the OAuth 2.0 authorization-code flow and stores the verified Google
subject on the Hive account. Existing accounts with a matching verified email are connected
on first Google sign-in. To enable it, create a Google OAuth client of type **Web application**,
add `WEB_ORIGIN/api/auth/google/callback` as an authorized redirect URI, then configure
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the API and set
`NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED=true` on the web service. The web variable is baked in at
build time, so rebuild the web service after changing it. For local development, set
`API_PROXY_TARGET=http://localhost:4000` so the OAuth callback and refresh cookie remain
first-party. Apply the new `users.google_sub` migration with `pnpm --filter @hive/server db:migrate`
before deploying the API change.

Configure `JWT_SECRET`, `ACCESS_TOKEN_MINUTES`, `REFRESH_TOKEN_DAYS`, and
`COOKIE_SECURE` in `apps/server/.env` (see `.env.example`). Replace the development
secret and enable secure cookies when serving over HTTPS.

## Testing

```bash
cd apps/server
python -m uv run pytest -q      # integration tests against a separate hive_test database
python -m uv run ruff check .
cd ../..
pnpm --filter @hive/shared build
pnpm --filter @hive/web typecheck
```

Tests recreate only the `hive_test` database and clear only `rl:*` rate-limit keys, so local
development data is never touched.

## Spaces & permissions

Communities are public and searchable; workspaces are invite-only unless they allow a matching
email domain. Non-members cannot discover private workspaces. Every new space starts with its
creator as owner and a `general` text channel. Invite codes are single-use or reusable according
to their configured limit, expire when configured, and can be revoked. Use `pnpm --filter
@hive/server db:seed` for repeatable demo data.

| Role | Rank | Capabilities |
| --- | ---: | --- |
| owner | 5 | Edit and delete the space, manage channels, invites, members, and lower roles |
| admin | 4 | Edit the space, manage channels and invites, manage lower-ranked members |
| moderator | 3 | Remove lower-ranked members |
| member | 2 | Participate in a space |
| guest | 1 | Read messages |

## Real-time chat

Text channels support plain-text messages, typing indicators, author edits, and author or
moderator deletion. Public community history is readable without logging in; private workspace
history requires membership. Sending requires a member role or higher.

The composer shows messages immediately and replaces pending entries when the server confirms
them. Every send carries a client-generated UUID. A unique index on `(author_id, client_msg_id)`
and an atomic insert make retries idempotent, so retrying a failed send cannot create duplicates.
Events are broadcast only after commit, and duplicate retries return the original message.

After reconnecting, clients rejoin their channel and sync from their newest known ULID, paging
through missed messages in order. Older history uses a separate backward cursor. Socket.IO's
Redis manager fans events out across server instances; configure `SOCKETIO_CHANNEL` to isolate
deployments (tests use their own channel). Run the seed to populate example conversations.

## Threads, reactions, files, presence, unread

- **Threads:** a reply is a message with `parent_id` (one level deep). Channel history only
  returns top-level messages; `GET /api/messages/{id}/thread` returns the parent and its replies.
  The parent's `reply_count` is incremented in the same transaction, so idempotent retries never
  count twice.
- **Reactions:** `reaction:toggle` adds or removes one emoji per user (primary key
  `message_id, user_id, emoji`; at most 20 different emoji per message) and broadcasts the new
  totals.
- **Files:** `POST /api/channels/{id}/uploads` stores up to 10 MB per file under `UPLOAD_DIR`, then
  `message:send` claims up to 5 files with `attachmentIds` (only the uploader's unclaimed files in
  the same channel). Downloads use HMAC-signed URLs that expire, so `<img>` tags work without an
  auth header. Only PNG/JPEG/GIF/WebP render inline; everything else downloads as
  `application/octet-stream` with `nosniff`.
- **Presence:** each user's connected socket ids live in a Redis set shared by all instances.
  The first connection broadcasts `online`, the last disconnect broadcasts `offline`, and member
  lists include an `online` flag.
- **Unread counts:** `channel_reads` stores the newest message each user has seen. The marker only
  moves forward (`GREATEST`), the channel list returns `unread` per channel, and
  `channel:activity` events update badges for other channels live.

## Direct messages

Private one-to-one and group conversations (up to 9 people) live outside spaces at `/dms`. A
conversation is a `dm` channel with no space plus `dm_members` rows, so messages, threads,
reactions, files and unread markers reuse the channel code. Each group of people has exactly one
conversation: `channels.dm_key` stores the sorted participant ids under a unique index, and
`POST /api/dms` upserts on it. To limit spam, you can only message people who share a space with
you (`GET /api/users/search`). Non-participants get 404 for history, uploads and socket joins.
New messages are announced to every participant's `user:{id}` room (`dm:activity`) for the
conversation list and the unread badge in the navigation bar, and presence changes reach DM
partners the same way.

## Home

`/home` is one Slack-style screen: a sidebar with a space switcher, "Find a conversation"
(Ctrl+K), **Unreads**, **Threads**, the space's **Channels**, **Conversations** (group DMs) and
**Direct messages**, and the open chat on the right. The URL holds the state
(`?s=<space>&c=<channel or DM>&t=<thread>` or `&view=unreads|threads`), so links and the back
button work; on phones the sidebar becomes a drawer.

- `GET /api/me/unreads` lists every channel and DM of yours with unread messages (DMs first).
- `GET /api/me/threads` lists threads you started or replied to, ordered by their newest reply
  and paged with `before=<last_reply_id>`. Each thread has its own forward-only read marker
  (`thread_reads`, set with the `thread:read` event); without one, replies after your first
  message in the thread count as new. Replies are announced to every participant with
  `thread:activity`.
- `space:watch` / `space:unwatch` subscribe a socket to a space's `channel:activity` and presence,
  so sidebar badges stay live while a DM is open. Leaving or being removed from a space ends it.

## Posts & ranking

Spaces have Reddit-style text, link and title-only posts (`/s/<slug>?tab=posts`, `/p/<id>`), and
`/feed` combines the posts of your spaces (or all public communities when logged out). Members
vote up or down; authors can edit the body or link (not the title) and authors or moderators
can delete.

- **Hot** uses the classic formula `sign(score) * log10(max(|score|, 1)) + created_epoch / 45000`
  (`app/posts/ranking.py`). The time term gives every newer post a steadily higher baseline, while
  each 10x more score is worth about 12.5 hours, so fresh posts with some votes rise above old
  popular ones. It is recomputed in the same transaction as every vote.
- **New** orders by ULID, **Top** by score within a time window (day, week, month, year, all).
- **Keyset cursors**, not offsets: `next_cursor` is an opaque base64 value of the last row's sort
  key (`[hot, id]`, `[score, id]` or `[id]`), compared with a row-value `(key, id) < (…)`, so
  pages stay stable while votes and new posts arrive.
- **Race-safe voting:** the post row is locked (`SELECT … FOR UPDATE`), the vote is changed, and
  the counters are updated with SQL arithmetic in one transaction, so concurrent votes never lose
  updates and repeating the same vote changes nothing. A `CHECK (value IN (-1, 1))` constraint
  guards the votes table.
- Live updates: `post:new` and `post:score` are broadcast to the space room. Limits: 5 posts per
  10 minutes and 60 votes per minute per user.

## Media & storage

Posts support up to ten images or one video, with optional text. Chat also plays videos inline.
Uploads show progress and can be cancelled. Galleries have keyboard navigation and a lightbox.
The server detects PNG, JPEG, GIF, WebP, MP4 and WebM from their bytes; renamed HTML and SVG
remain downloads with `nosniff`. Default limits are 10 MB for images/files and 100 MB for video,
configured with `MAX_IMAGE_MB`, `MAX_FILE_MB` and `MAX_VIDEO_MB`.

`STORAGE_DRIVER=local` stores objects beneath `UPLOAD_DIR` and serves HMAC-signed downloads,
including HTTP range requests for seeking. Existing attachment paths remain supported.
To deploy with Supabase, create a **private** Storage bucket named `hive-media` in your Supabase
project and set `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and
`SUPABASE_BUCKET` on the API server (see `.env.example`). The service role key stays on the
server because it grants privileged storage access; never put it in frontend environment variables.
The API streams uploads through the Storage REST API, signs all files for a response in one
request, and caches signed URLs in Redis. `SIGNED_URL_SECONDS` defaults to 3600. Browsers get
only expiring signed URLs; ordinary files use download disposition. No storage SDK is required.

## Comments, reposts & sharing

- **Nested comments** store their ancestry in a Postgres `ltree` path (`<root id>.<child id>…`;
  ULIDs are valid labels). A GiST index makes "this subtree" (`path <@ ANY(...)`) one indexed
  query, so a page of 20 top-level comments plus five levels of replies (max 300 comments) loads
  in a constant number of SQL statements no matter how big the thread is. The tree is built and
  sorted in Python; deeper chains continue via `GET /api/comments/{id}`. Deleted comments keep
  their place as `[deleted]` so replies stay readable.
- **Best** sorting uses the lower bound of the Wilson score interval (80% confidence) instead of
  raw score: one upvote with no downvotes is not treated as better than 40 up and 5 down, because
  the uncertainty of tiny samples is taken into account. Top, New and Old are also available, and
  sorting applies among siblings at every level. Paging cursors carry the value Postgres computed,
  so no comment is repeated or skipped between pages.
- **Comment votes** use the same race-safe pattern as post votes (row lock, SQL arithmetic,
  `CHECK (value IN (-1, 1))`). New comments, edits, deletions and score changes are pushed live to
  everyone viewing the post (`post:watch`).
- **Reposts** share a community post into another space you belong to, always pointing at the
  root original. Workspace posts cannot be reposted, so private content never leaves its
  workspace.
- **Sharing:** copy link, the device's native share sheet, or send to a channel or DM. Hive post
  links in chat show a preview card, but only for viewers who can read that post; nothing from a
  private workspace is revealed to outsiders.

## Discover and manage communities

Explore at `/spaces` offers **For You**, **Following**, **Recent** and **Trending**, with category
filters and search across names, descriptions and tags. Communities have one of 16 categories
and up to five tags. Save optional interests in Settings to personalise suggestions; without
interests, For You shows Trending. Private workspaces never appear in Explore.

Use `/communities/manage` to mute, favourite, reorder or leave your spaces. Favourites appear
first in the rail and space switcher. Muting removes ordinary channel activity from personal
unread totals while preserving mentions, direct messages and each channel's own unread marker.
Owners cannot leave their space.

Owners and administrators can edit up to 15 ordered rules in space settings. New community
members must agree before joining a community with rules; existing members keep their access.
`/policies` links to guidelines, content, privacy and terms pages. The policy text is a template
and requires legal review before launch.

Developer entry points:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/explore/communities`, `GET /api/explore/categories` | Ranked, cursor-paginated discovery and category counts |
| `GET/PUT /api/me/interests` | Read or replace interests |
| `PATCH /api/me/spaces/{slug}`, `PUT /api/me/spaces/order` | Membership preferences and ordering |
| `GET/PUT /api/spaces/{slug}/rules` | Read or replace ordered rules |
| `POST /api/spaces/{slug}/join` | Join, with `agreedToRules: true` when rules exist |

The category catalogue lives in `packages/shared/src/categories.json`; a backend test checks
the Python slugs against it. Migration `160fdc63dd30` adds categories, interests, membership
preferences and rules, defaulting existing spaces to `other`. Inside `apps/server`, apply it with
`python -m uv run alembic upgrade head`, then run `python -m uv run alembic check`. Backend
tests cover discovery, permissions, muted unread counts and an isolated migration backfill and
downgrade/upgrade round trip.

## Message composer

The message box supports a safe Markdown subset (bold, italic, strike, code, code blocks, lists,
quotes and links) with a toolbar and keyboard shortcuts (`Ctrl/Cmd+B`, `I`, `E`, `K`, ...), plus:

- **Mentions and channel links**: type `@` or `#` to pick a person or channel. Mentions are stored
  as ids, so renaming someone never breaks old messages.
- **Emoji picker** and **slash commands**: `/poll "Question" "A" "B"`, `/remind in 30m text`,
  `/status :coffee: Focusing`, `/shrug`.
- **Polls** with live results, anonymous votes and closing by the author.
- **Reminders** and **scheduled messages**, delivered by a background scheduler
  (`app/scheduler.py`) that re-checks permissions at send time. Reminders arrive in a private
  conversation with "Hive".
- **Drafts** are saved on the server as you type and restored on any device. The
  **Drafts & scheduled** view lists drafts, scheduled messages and reminders, and channels with an
  unsent draft show a pencil in the sidebar.
- **Voice messages** (up to 5 minutes) with a waveform player.
- **Link previews** fetched server-side with SSRF protection (public addresses only, size and time
  limits, HTML only).

The Markdown parser lives in `packages/shared/src/markdown.ts` and has its own tests
(`pnpm --filter @hive/shared test`).

## Games

Every community has a **Games** page (`/s/<slug>/games`, and `/games` lists your communities):

- **Daily Word**: one five-letter puzzle per community per UTC day, six guesses, per-letter feedback computed on the server. The answer is derived from `GAME_SECRET`, the community id and the date, and is never sent before you finish. Solving in N guesses earns `7 - N` points. "Copy result" shares an emoji grid without letters.
- **Trivia**: admins write quizzes (or add a ready-made pack of ten questions). Each member plays a quiz once. The server keeps the correct answers, enforces the per-question time limit with its own clock and scores 10 points per correct answer plus up to 5 for speed.
- **Predictions**: admins ask a question with 2 to 6 options and a closing time. Members vote (and can change their vote until it closes). Owners and admins settle it; everyone who voted for the winning option gets the points once.
- **Leaderboards** (today, this week, all time) are sums over the append-only `game_scores` table. The top three of the previous ISO week carry a "Top player" badge in the leaderboard and member list.

Workspaces have no games. Setting: `GAME_SECRET`.

## AI features

Optional, off by default. When no key is set, the AI buttons are hidden and the endpoints answer `503 {"code": "ai_disabled"}`.

| Variable | Meaning | Default |
|---|---|---|
| `AI_PROVIDER` | `disabled` or `anthropic` | `disabled` |
| `ANTHROPIC_API_KEY` | API key for the Anthropic Messages API | empty |
| `AI_MODEL` | model id | `claude-sonnet-5-5` |
| `AI_RATE_LIMIT_PER_HOUR` | model calls per user per hour | `60` |
| `AI_MAX_INPUT_CHARS` | text sent per request | `24000` |
| `AI_MAX_OUTPUT_TOKENS` | answer length cap | `2000` |

To enable: set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `apps/server/.env`, then restart the API.

What it does:

- **Catch me up**: on the Unreads view and in each channel header. Short bullet points of what you have not read (or the last 24 hours), each linking to the source message. The thread panel has **Summarise thread**.
- **Huddle notes**: under a huddle summary line, summarise the chat sent during the huddle and add the action items to your to-dos.
- **Sort by priority** (Unreads): ranks unread conversations as Urgent, For you or Later with a one-line reason; cached per user for 10 minutes.
- **Translate**: choose a language in Settings. Other people's messages, posts and comments then show a Translate link; "Translate all" in a channel header does it for the whole channel in batches. Translations are cached per item, language and text.
- **Rewrite** in the composer (shorter, professional, friendlier, fix grammar) shows a suggestion you accept or discard; nothing is sent automatically.
- **Ask Hive** (rail button or Ctrl+J): answers a question using full-text search over content you can read, with source links.

Privacy and safety:

- Text is only sent after the same access check as reading it in the app (members, private channels, DMs for participants); deleted messages, system lines and people you blocked are skipped. One module, `app/ai/context.py`, decides what may be sent.
- Conversation text is put in the user turn inside an `<untrusted_content>` block that cannot be closed from inside, and the system prompt tells the model to treat it as data. Answers are shown as plain text; links to messages are built by the server.
- Calls are rate limited per user, counted in `ai_usage` (`GET /api/me/ai-usage` shows your last 30 days). Prompts and keys are never logged.
- Tests use a fake provider or a mocked HTTP transport; no network is used.
## Files, saved items, notifications and search

**For users**
- **Files**: every channel and conversation has a Files tab (filter by type, person or file name; images and videos open in a viewer). *All files* in the sidebar lists everything you can read, with a space filter.
- **Profile**: crop, zoom and rotate your photo and cover image before saving (Settings, Profile).
- **Saved items**: use *Save* on a message, post or comment; find them under *Saved items*. Items you can no longer read disappear from the list.
- **Notifications**: the bell shows an unread count. The inbox lists mentions, thread replies, reactions, post comments, accepted invites and direct messages that arrived while you were offline. Switch each type on or off in Settings, Notifications.
- **Search**: Ctrl/Cmd+K opens search over messages, posts, comments, people, channels and files, with filters for space, person and dates. `/search` shows the same results as a page.

**For developers**
- `app/access.py` is the single access rule (SQL conditions for readable channels, DMs, posts and messages, plus block filtering). Files, saved items, notifications and search are all built on it, and re-check access on every read.
- Endpoints: `GET /api/channels/{id}/files`, `GET /api/files`, `PUT/DELETE /api/saved/{messages|posts|comments}/{id}`, `GET /api/saved`, `GET /api/saved/ids`, `GET /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/{id}/read`, `POST /api/notifications/read-all`, `GET/PUT /api/notifications/preferences`, `GET /api/search`, `POST/DELETE /api/me/cover`, `GET /api/users/{id}/cover`.
- Socket events: `notification:new` (the full item) and `notification:count` go to the `user:{id}` room.
- Search uses PostgreSQL full-text search (`simple` configuration) on generated `search_tsv` columns with GIN indexes; people and file names use escaped `ILIKE`. Highlights are returned as `{text, match}` segments, never HTML.

## Apps & workflows

Owners and admins manage everything under **Space settings, Apps & workflows** (`/s/<slug>/settings/apps`).
Secrets (webhook addresses, bot tokens, signing secrets) are shown once and stored hashed (tokens) or
readable only to the server (signing secrets); members never see them.

- **Incoming webhooks**: `POST /api/hooks/<token>` with `{"text": "...", "username": "optional"}` (Markdown
  subset, up to 4000 characters, 30 requests per minute per hook). Messages show an `APP` badge.
- **Bots**: `POST /api/bot/messages` (`channelId`, `text`, `parentId?`), `GET /api/bot/channels` and
  `GET /api/bot/channels/<id>/messages` with `Authorization: Bearer <token>`. A bot only reaches the
  channels an admin added it to, including private ones. Messages show a `BOT` badge.
- **Outgoing events**: a bot with an address receives signed JSON for `message.created` in its channels
  and for its slash commands. Headers: `X-Hive-Event`, `X-Hive-Timestamp`, `X-Hive-Signature`
  (`sha256=` + HMAC-SHA256 of the raw request body). Events are queued and retried with back-off by the
  scheduler. Only public http/https addresses on ports 80/443 are contacted (checked again on every send).
- **Custom slash commands**: `/name text` is sent to the bot, whose reply `{"text": "...", "ephemeral": false}`
  is posted in the channel, or shown only to the caller when `ephemeral` is true (socket event
  `command:response`). The list is `GET /api/spaces/<slug>/commands`.
- **Workflows**: triggers are a member joining, a keyword in a channel, an emoji reaction, or a daily or
  weekly schedule in a time zone. Actions post a message (as Hive or a bot, in a channel or as a direct
  message), create a to-do, or add the person to a private channel. Each workflow keeps its last 50 runs,
  never starts from messages that workflows post, and is limited to 20 runs per minute.

## Privacy extras and installable app

**Disappearing messages.** Any DM or group DM (and, for owners and admins, any text channel) can
be set to Off, 24 hours, 7 days or 30 days from the clock button in the chat header
(`PUT /api/channels/{id}/disappearing`). The timer applies to messages sent afterwards and leaves
a system line in the chat. Each message gets an `expires_at`; every read path (history, threads,
unread counts, search, saved items, notifications, files, AI context) hides it as soon as it
passes, and the scheduler (`app/disappearing/service.py: expire_due`) erases the rows together with
their replies, reactions and stored files.

**View once.** In a direct message, photos and videos can be sent as "View once". Recipients see a
blurred card; opening it (`POST /api/attachments/{id}/view-once`) returns a 30 second link exactly
once per person. The sender sees "Opened" or "Not opened yet" (in a group, "Opened" once everyone
has). View-once media has no address in normal payloads and is left out of Files, search and saved
items.

**Secret conversations.** "Start a secret conversation" opens a separate, end-to-end encrypted DM.
Every browser creates an ECDH P-256 key pair with WebCrypto (the private key is a non-extractable
key in IndexedDB) and uploads the public key (`/api/me/devices`). Text is encrypted per target
device with AES-GCM using a key from ECDH + HKDF (`packages/shared/src/secret.ts`); the server
stores and relays only ciphertext, and never searches, previews, summarizes or notifies with it
(notifications say "New secret message"). Both people can compare a safety number. Limits: text
only, no editing or threads, and a new device cannot read older messages.

**Installable app and push notifications.** Hive ships a web app manifest, icons, a service worker
(`public/sw.js`) with an offline page, and Web Push. Browsers offering it show "Install Hive" in the
account menu. Push is off until VAPID keys are set:

```bash
cd apps/server
python -m uv run python -m app.push.keys     # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Put the output (and `VAPID_SUBJECT=mailto:you@example.com`) in `apps/server/.env`. People then
turn on "Push notifications on this device" and optional quiet hours under Settings, Notifications.
Pushes are sent for new inbox notifications when the person has no open connection, respecting their
notification settings and quiet hours. Payloads are encrypted (RFC 8291) and signed (VAPID, ES256)
with the `cryptography` package.
