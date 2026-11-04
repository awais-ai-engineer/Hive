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
5. Posts, voting, hot/top/new ranking
6. Nested comments (ltree), public community pages
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
