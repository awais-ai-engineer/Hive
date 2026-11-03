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
pnpm dev                                       # web + server, with hot reload
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
2. Spaces, roles, invites, channels
3. Real-time chat: idempotent send, optimistic UI, reconnect sync
4. Threads, reactions, uploads, presence, unread counts
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
