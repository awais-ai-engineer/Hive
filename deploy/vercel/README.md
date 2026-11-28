# Hive frontend on Vercel

## Project setup

- Import the existing GitHub repository `awais-ai-engineer/Hive`.
- Use the existing Vercel account/team and Hobby only if Hive's use qualifies as
  personal and non-commercial under Vercel's current terms. If Hive is used for a
  business/commercial purpose, stop and select an eligible plan or host; do not
  deploy it to Hobby.
- Framework preset: **Next.js**.
- Root directory: `apps/web`.
- Enable **Include source files outside of the Root Directory** for the pnpm
  workspace packages.
- Install command: `cd ../.. && pnpm install --frozen-lockfile`.
- Build command: `cd ../.. && pnpm exec turbo run build --filter=@hive/web`.
- Output directory: leave the Next.js default.
- Keep the current Git production branch unchanged until the intended PR/branch
  is selected for release. Git integration should build previews for PRs and
  production only from the approved production branch.
- `hive-workspace.vercel.app` and `hive-collab.vercel.app` are occupied. Vercel
  project `hive-connect` is created and its production build is deployed;
  `hive-connect.vercel.app` is the selected origin pending backend CORS and OAuth
  activation. Do not remove or alter the existing VPS domain.

## Environment variables

Set these for **Production** in the Vercel project. Add them to Preview only when
preview access is intentionally enabled and backend CORS has the exact preview
origin configured.

| Variable | Value | Exposure |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://hive.blackbox-n8n.duckdns.org` | Public build value |
| `NEXT_PUBLIC_WEB_URL` | `https://hive-connect.vercel.app` | Public build value |
| `NEXT_PUBLIC_AUTH_PROXY` | `1` | Public build value |
| `NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED` | `true` only after backend OAuth credentials and Google configuration are verified | Public build value |
| `API_PROXY_TARGET` | `https://hive.blackbox-n8n.duckdns.org` | Server-only; never prefix with `NEXT_PUBLIC_` |

`/api/auth/*` is rewritten through the Vercel server to the VPS so refresh-cookie
requests are same-origin. Other REST calls, uploads, and Socket.IO connect directly
to the existing VPS hostname; upload bodies do not traverse Vercel Functions.
Socket.IO uses HTTPS-origin TLS (`wss://`) and the existing authenticated socket
token. The backend must allow the exact Vercel origin in both FastAPI CORS and
Socket.IO CORS. No wildcard origin is required.

Do not put `GOOGLE_CLIENT_SECRET`, the Supabase service key, JWT signing secrets,
database credentials, or VAPID private keys in Vercel frontend variables. Google
OAuth's client secret belongs only in the VPS backend `server.env`.

## Google Cloud OAuth client

Use the existing Google OAuth **Web application** client after rotating its
previously exposed client secret. Once the frontend hostname is confirmed, add
that exact authorized JavaScript origin:

```text
https://hive-connect.vercel.app
```

Add the matching exact authorized redirect URI:

```text
https://hive-connect.vercel.app/api/auth/google/callback
```

Store the replacement client secret as `GOOGLE_CLIENT_SECRET` in the VPS backend
environment and keep the existing client ID in `GOOGLE_CLIENT_ID`. Restart only
the Hive API after its values and canonical `WEB_ORIGIN` have been configured.
The Next.js same-origin rewrite carries the auth callback and host-only cookies
through the Vercel domain. Hive retains its current JWT/refresh-token system and
existing Google subject mappings. Verify the consent screen, external-user status,
test-user restrictions, requested scopes (`openid`, `email`, `profile`), and Google
domain verification/brand status in the existing Cloud project; Vercel does not
automatically verify domains with Google. A shared `vercel.app` hostname is not a
domain Hive owns. Google requires ownership verification for domains associated
with a production OAuth consent screen, so public Google sign-in may require a
Hive-owned custom domain even if the app can be tested with Google test users on
an unverified OAuth consent screen.

## Traffic and request limits

Only small auth requests use the Vercel rewrite. File uploads use the existing
direct API upload path, preserving progress events and the VPS Nginx upload limit.
Supabase Storage remains the persistent media store. Keep the Nginx Socket.IO
upgrade route and long read timeout enabled; Vercel is not the WebSocket server.

## Cutover checks

Before switching users, verify the Vercel build, `/api/auth/refresh` rewrite,
Google login and callback, email/password login, direct API CORS, socket upgrade,
uploads/downloads, Huddles, invitations and push. Browser refresh tokens are
host-only; users may need to sign in again on the Vercel hostname. Push
subscriptions are also browser-origin scoped, so users may need to re-enable
browser notifications there. Keep the old site available through this verification.
