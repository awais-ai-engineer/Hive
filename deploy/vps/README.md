# Hive VPS deployment

This deployment keeps the existing PostgreSQL and media data in Supabase, runs
Hive's API, Next.js web app, and Redis in separate containers, and adds a new Nginx
virtual host. It does not replace the existing n8n or other Nginx sites.

## First deployment

1. Copy `.env.example` to `.env`; set `PUBLIC_URL` to the hostname that resolves to
   the VPS and generate a unique `REDIS_PASSWORD` with `openssl rand -hex 32`.
2. Copy `server.env.example` to `server.env` and populate it from the existing
   production environment. In particular, retain the current `DATABASE_URL` and
   `JWT_SECRET` so Hive uses the same database and existing logins remain valid.
   Keep the Supabase service key server-side only. Set the existing Google OAuth and
   VAPID values if those features are enabled in production.
3. Back up the production PostgreSQL database before starting the API. The API
   applies the additive Alembic migration before accepting traffic.
4. Build and start from this directory with `docker compose -f compose.yaml up -d --build`.
   Verify `http://127.0.0.1:4000/api/health` and the web container before touching Nginx.
5. Install `nginx.conf` as a new site, run `nginx -t`, then enable/reload it. Obtain a
   certificate for the new hostname with Certbot. Keep the existing Nginx sites intact.
6. Verify sign-in, posting, uploads, Socket.IO, and database migration over HTTPS.

## Rollback

Stop only the `hive` Compose project with `docker compose -f compose.yaml down`.
Disable the `hive` Nginx site and reload Nginx. Keep the PostgreSQL backup and Redis
volume. Do not downgrade the production database automatically; the migration is
additive and the previous API version remains compatible with the nullable column.

Do not commit `.env` or `server.env`. Keep both files readable only by the deployment
operator and never expose `SUPABASE_SERVICE_KEY` to the browser.
