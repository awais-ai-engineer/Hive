# Hive VPS services

The VPS remains the home of FastAPI, Socket.IO, Redis and moderation. The browser
app is deployed separately to Vercel. Supabase continues to provide the existing
database and storage. Keep the VPS Nginx route and the old site available for
rollback until the Vercel release has passed production checks.

## Environment

`deploy/vps/.env` is for Compose-only values and `deploy/vps/server.env` contains
backend secrets. Do not commit either file. Set:

| Variable | Value |
| --- | --- |
| `PUBLIC_URL` | `https://hive.blackbox-n8n.duckdns.org` (existing Nginx/API host) |
| `API_PUBLIC_URL` | `https://hive.blackbox-n8n.duckdns.org` |
| `WEB_ORIGIN` | `https://hive-connect.vercel.app` (selected available frontend hostname) |
| `WEB_ORIGINS` | `https://hive.blackbox-n8n.duckdns.org` during rollback window |
| `REDIS_PASSWORD` | Existing unique Redis password; do not rotate as part of frontend cutover |

Keep `DATABASE_URL`, `JWT_SECRET`, Supabase credentials, VAPID keys and all other
backend secrets unchanged. `WEB_ORIGIN` and `WEB_ORIGINS` are supplied to FastAPI
and Socket.IO as exact allowlisted browser origins; wildcard origins are not used.

## Existing deployment safety

The current running VPS stack and Nginx configuration must remain untouched until
the Vercel app is verified. For the frontend-origin change, use
`activate-vercel-origin.sh`; it updates only the Hive API container, keeps the old
origin explicitly trusted for rollback, and validates API health, CORS, and a
Socket.IO handshake. It does not run migrations or restart Redis, moderation, the
VPS web frontend, Nginx, n8n, or OpenClaw. Do not use the earlier DuckDNS
migration steps. Retain the existing Nginx route and certificate.

The VPS-hosted frontend is retained only as a rollback path. Its build arguments
use the existing API host and `WEB_ORIGIN`; Google login for the Vercel frontend is
configured independently in the Vercel project, with the OAuth secret stored only
on the backend.

## Vercel origin and Google OAuth activation

`activate-vercel-origin.sh` prompts for the Google Web OAuth client ID and the
freshly rotated client secret (secret input is hidden), writes them only to the
existing mode-600 `server.env`, then builds and restarts only the Hive API. Run it
from an interactive SSH terminal after adding the exact Google origin and callback
below. It backs up the prior API image and credentials and automatically restores
the old API configuration if its health/CORS/Socket.IO checks fail.

Google Cloud Console → Google Auth Platform → Clients: configure a **Web
application** client with Authorized JavaScript origin
`https://hive-connect.vercel.app` and Authorized redirect URI
`https://hive-connect.vercel.app/api/auth/google/callback`. In Audience, use
External + Testing and add the account(s) that will verify login as test users.
Hive requests only `openid email profile`. For public production OAuth, Google
requires compliant ownership/verification for the app's web domains; a shared
`vercel.app` hostname is not a Hive-owned domain, so public brand verification may
remain unavailable until Hive uses a domain it controls. Do not claim broad public
Google OAuth verification from a successful test-user login.

Vercel production environment variables (server-only/public scope as named):

| Name | Value |
| --- | --- |
| `API_PROXY_TARGET` | `https://hive.blackbox-n8n.duckdns.org` |
| `NEXT_PUBLIC_API_URL` | `https://hive.blackbox-n8n.duckdns.org` |
| `NEXT_PUBLIC_WEB_URL` | `https://hive-connect.vercel.app` |
| `NEXT_PUBLIC_AUTH_PROXY` | `1` |
| `NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED` | `false` until a browser login is verified; then `true` and redeploy |

## Rollback

Restore the previous `WEB_ORIGIN`/`WEB_ORIGINS` Compose values and redeploy only
the Hive API if the Vercel origin must be withdrawn. Keep the same JWT secret,
database, Supabase storage, Redis volume, Nginx sites, and existing n8n/OpenClaw
services. Do not restore or remove database data as part of a frontend rollback.
