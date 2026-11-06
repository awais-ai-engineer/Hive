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
