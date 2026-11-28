# Hive VPS deployment

This deployment keeps the existing PostgreSQL and media data in Supabase, runs
Hive's API, Next.js web app, Redis, and the existing internal moderation service in
separate containers, and adds a new Nginx
virtual host. It does not replace the existing n8n or other Nginx sites.

## First deployment

1. Copy `.env.example` to `.env`; set `PUBLIC_URL` to the hostname that resolves to
   the VPS and generate a unique `REDIS_PASSWORD` with `openssl rand -hex 32`.
2. Copy `server.env.example` to `server.env` and populate it from the existing
   production environment. In particular, retain the current `DATABASE_URL` and
   `JWT_SECRET` so Hive uses the same database and existing logins remain valid.
   Keep the Supabase service key server-side only. Set the existing Google OAuth and
   credentials only after rotating any previously exposed OAuth secret. This VPS
   setup keeps Google sign-in disabled until fresh credentials and callback URLs
   are configured. VAPID keys may be generated locally and kept only in `server.env`.
3. Keep `.env` and `server.env` mode `600`. The operator's `server.env` must contain
   the real production `DATABASE_URL`, `JWT_SECRET`, Supabase URL/service key, bucket,
   and matching VAPID keys. No secret belongs in Git or the browser bundle.
4. From Windows PowerShell, run the single guarded deployment command:

   ```powershell
   ssh -tt -i "$env:USERPROFILE\.ssh\hive-vps-deploy" admin@163.123.181.8 "sudo bash /home/admin/hive-pr53-5d6a0d9/deploy/vps/deploy-admin.sh"
   ```

   Enter the normal `admin` sudo password at the SSH terminal prompt. The script does
   not alter sudoers or group membership. It inventories containers first, refuses
   conflicting Hive container/port/site names, writes a root-only PostgreSQL backup,
   validates it, builds and starts only Hive's Compose project (including the existing
   internal moderation service), then lets the API apply the additive Alembic migration.
   It adds only the Hive hostname-specific Nginx site, obtains a free Let's Encrypt
   certificate using the ACME webroot, reloads Nginx (never restarts the VPS), and
   checks HTTPS, API health, Socket.IO/WebSocket upgrade, and certificate renewal.
   The already-active Certbot timer handles future renewal. The script aborts before
   adding the public route if backup, build, migration, health checks, or ACME setup fail.

## Rollback

Stop only the `hive` Compose project with `docker compose -f compose.yaml down`.
Disable the `hive` Nginx site and reload Nginx. Keep the PostgreSQL backup and Redis
volume. Do not downgrade the production database automatically; the migration is
additive and the previous API version remains compatible with the nullable column.

Do not commit `.env` or `server.env`. Keep both files readable only by the deployment
operator and never expose `SUPABASE_SERVICE_KEY` to the browser.
