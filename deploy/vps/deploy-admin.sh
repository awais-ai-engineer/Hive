#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/home/admin/hive-pr53-5d6a0d9
DEPLOY="$ROOT/deploy/vps"
COMPOSE="$DEPLOY/compose.yaml"
ENV_FILE="$DEPLOY/.env"
SERVER_ENV="$DEPLOY/server.env"
DOMAIN=
BACKUP_DIR=/var/backups/hive
REPORT="$DEPLOY/deploy-report.txt"
SITE=/etc/nginx/sites-available/hive
SITE_LINK=/etc/nginx/sites-enabled/hive
TEMP_SITE_ACTIVE=0
SITE_COMMITTED=0
WORKDIR=$(mktemp -d /run/hive-deploy.XXXXXX)

fail() { echo "DEPLOY_ABORTED: $*" >&2; exit 1; }

on_exit() {
    status=$?
    if [[ $status -ne 0 && $TEMP_SITE_ACTIVE -eq 1 && $SITE_COMMITTED -eq 0 ]]; then
        rm -f "$SITE_LINK" "$SITE"
        if nginx -t >/dev/null 2>&1; then systemctl reload nginx || true; fi
    fi
    rm -f "$WORKDIR/pgpass" "$WORKDIR/pginfo" "$WORKDIR/pre-cert.conf"
    rmdir "$WORKDIR" 2>/dev/null || true
    exit "$status"
}
trap on_exit EXIT

[[ $(id -u) -eq 0 ]] || fail "run this script with sudo from the admin account"
command -v docker >/dev/null || fail "Docker is not installed"
command -v nginx >/dev/null || fail "Nginx is not installed"
command -v certbot >/dev/null || fail "Certbot is not installed"
command -v curl >/dev/null || fail "curl is not installed"
command -v python3 >/dev/null || fail "Python 3 is not installed"
[[ -f "$COMPOSE" && -f "$ENV_FILE" && -f "$SERVER_ENV" ]] || fail "staged Hive files are incomplete"

exec 9>/run/lock/hive-vps-deploy.lock
flock -n 9 || fail "another Hive deployment is running"

chmod 600 "$ENV_FILE" "$SERVER_ENV"
PUBLIC_URL=$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)
DOMAIN=$(python3 - "$PUBLIC_URL" <<'PY'
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if url.scheme != "https" or not url.hostname or url.path or url.query or url.fragment or url.username or url.password:
    raise SystemExit(1)
print(url.hostname)
PY
) || fail "PUBLIC_URL must be a valid HTTPS origin"
[[ "$PUBLIC_URL" == "https://$DOMAIN" && "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "PUBLIC_URL must be a canonical HTTPS origin without a path or port"
grep -q '^DATABASE_URL=.' "$SERVER_ENV" || fail "DATABASE_URL is empty"
grep -q '^JWT_SECRET=.' "$SERVER_ENV" || fail "JWT_SECRET is empty"
grep -q '^SUPABASE_URL=https://.*\.supabase\.co' "$SERVER_ENV" || fail "Supabase URL is missing"
grep -q '^SUPABASE_SERVICE_KEY=.' "$SERVER_ENV" || fail "Supabase server key is empty"
grep -q '^VAPID_PUBLIC_KEY=.' "$SERVER_ENV" || fail "VAPID public key is empty"
grep -q '^VAPID_PRIVATE_KEY=.' "$SERVER_ENV" || fail "VAPID private key is empty"
grep -q '^NEXT_PUBLIC_GOOGLE_LOGIN_ENABLED=false$' "$ENV_FILE" || fail "Google sign-in must remain disabled until its OAuth secret is rotated"

echo "-- Existing Docker containers (read-only inventory) --"
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
echo "-- Existing Compose projects (read-only inventory) --"
docker compose ls --all
docker info >/dev/null || fail "Docker daemon is not available"

if docker ps -aq --filter label=com.docker.compose.project=hive | grep -q .; then
    fail "a Compose project named hive already exists; refusing to recreate or stop it"
fi
for name in hive-api-1 hive-web-1 hive-redis-1 hive-moderation-1; do
    if docker ps -aq --filter "name=^/${name}$" | grep -q .; then
        fail "container name $name already exists; refusing to alter it"
    fi
done
if ss -H -ltn '( sport = :3000 or sport = :4000 )' | grep -q .; then
    fail "host port 3000 or 4000 is already in use"
fi

if [[ -e "$SITE" || -L "$SITE_LINK" ]]; then
    fail "Hive Nginx site path already exists; refusing to overwrite it"
fi
if nginx -T 2>/dev/null | grep -Fq "server_name $DOMAIN;"; then
    fail "an existing Nginx server block already claims $DOMAIN"
fi
nginx -t >/dev/null || fail "current Nginx configuration is invalid; leaving it untouched"
docker compose -f "$COMPOSE" --project-directory "$DEPLOY" config --quiet || fail "Hive Compose config is invalid"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
available_kb=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
[[ ${available_kb:-0} -ge 5000000 ]] || fail "less than 5 GB free for a safe database backup"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="hive-pre-deploy-${stamp}.dump"

echo "Preparing a root-only PostgreSQL backup before migrations..."
python3 - "$SERVER_ENV" "$WORKDIR/pgpass" "$WORKDIR/pginfo" <<'PY'
import os, sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

env = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        env[key] = value
raw = env.get("DATABASE_URL", "")
if raw.startswith("postgresql+asyncpg://"):
    raw = "postgresql://" + raw.split("://", 1)[1]
u = urlsplit(raw)
if u.scheme not in ("postgresql", "postgres") or not u.hostname or not u.username or not u.password or not u.path.strip("/"):
    raise SystemExit("DATABASE_URL is not a complete PostgreSQL URL")
host, port = u.hostname, u.port or 5432
database, user, password = unquote(u.path.lstrip("/")), unquote(u.username), unquote(u.password)
params = parse_qs(u.query)
sslmode = params.get("sslmode", params.get("ssl", ["require"]))[0]
if sslmode == "require":
    sslmode = "require"
if any("\n" in x or "\r" in x for x in (host, database, user, password, sslmode)):
    raise SystemExit("DATABASE_URL contains an invalid line break")
escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
Path(sys.argv[2]).write_text(":".join(map(escape, (host, str(port), database, user, password))) + "\n")
os.chmod(sys.argv[2], 0o600)
Path(sys.argv[3]).write_text("\n".join((host, str(port), database, user, sslmode)) + "\n")
PY
mapfile -t pginfo < "$WORKDIR/pginfo"
[[ ${#pginfo[@]} -eq 5 ]] || fail "could not parse database connection settings"
docker run --rm --network host --user 0:0 \
    -e "PGHOST=${pginfo[0]}" -e "PGPORT=${pginfo[1]}" -e "PGDATABASE=${pginfo[2]}" \
    -e "PGUSER=${pginfo[3]}" -e "PGSSLMODE=${pginfo[4]}" -e PGPASSFILE=/run/pgpass \
    -v "$WORKDIR/pgpass:/run/pgpass:ro" -v "$BACKUP_DIR:/backup" \
    postgres:18-alpine pg_dump --format=custom --no-owner --no-acl --file="/backup/$backup_name" \
    || fail "database backup failed; migration and deployment were not started"
chmod 600 "$BACKUP_DIR/$backup_name"
docker run --rm --user 0:0 -v "$BACKUP_DIR:/backup:ro" postgres:18-alpine pg_restore --list "/backup/$backup_name" >/dev/null \
    || fail "database backup archive validation failed"
echo "DATABASE_BACKUP=verified:$BACKUP_DIR/$backup_name"

docker compose -f "$COMPOSE" --project-directory "$DEPLOY" build
docker compose -f "$COMPOSE" --project-directory "$DEPLOY" up -d

api_ok=0
for _ in $(seq 1 60); do
    if curl -fsS --max-time 4 http://127.0.0.1:4000/api/health \
        | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("status")=="ok" else 1)' 2>/dev/null; then
        api_ok=1
        break
    fi
    sleep 2
done
[[ $api_ok -eq 1 ]] || fail "API readiness failed; Hive stack remains isolated and no Nginx route was added"
curl -fsS --max-time 10 http://127.0.0.1:3000/ >/dev/null || fail "web application failed local HTTP check"
curl -fsS --max-time 10 -H "Origin: $PUBLIC_URL" \
    'http://127.0.0.1:4000/socket.io/?EIO=4&transport=polling&t=hive-preflight' \
    | grep -q '"sid"' || fail "Socket.IO polling handshake failed"
migration=$(docker compose -f "$COMPOSE" --project-directory "$DEPLOY" exec -T api uv run alembic current 2>/dev/null | tail -n 1 | awk '{print $1}')
[[ "$migration" == c4b13a91d572 ]] || fail "expected post-channel migration head c4b13a91d572; got ${migration:-unknown}"

mkdir -p /var/www/hive-acme/.well-known/acme-challenge
chmod 755 /var/www/hive-acme /var/www/hive-acme/.well-known /var/www/hive-acme/.well-known/acme-challenge
cat > "$SITE" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/hive-acme;
        default_type text/plain;
    }
    location / { return 404; }
}
NGINX
sed -i "s/__DOMAIN__/$DOMAIN/g" "$SITE"
ln -s "$SITE" "$SITE_LINK"
TEMP_SITE_ACTIVE=1
nginx -t
systemctl reload nginx

certbot certonly --webroot -w /var/www/hive-acme -d "$DOMAIN" --cert-name "$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --preferred-challenges http --keep-until-expiring \
    || fail "Let's Encrypt issuance failed; existing services remain routed as before"
[[ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" && -s "/etc/letsencrypt/live/$DOMAIN/privkey.pem" ]] \
    || fail "certificate files were not created"

sed "s/__DOMAIN__/$DOMAIN/g" "$DEPLOY/nginx.conf" > "$WORKDIR/hive.nginx.conf"
install -m 644 "$WORKDIR/hive.nginx.conf" "$SITE"
nginx -t
systemctl reload nginx
SITE_COMMITTED=1
TEMP_SITE_ACTIVE=0

systemctl is-active --quiet certbot.timer || systemctl enable --now certbot.timer
certbot renew --dry-run --cert-name "$DOMAIN" >/dev/null || fail "certificate renewal dry-run failed"

curl -fsS --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" >/dev/null \
    || fail "HTTPS frontend check failed"
curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("API_HEALTH="+d.get("status","unknown")); sys.exit(0 if d.get("status")=="ok" else 1)' \
    || fail "public API health check failed"
ws_status=$(curl -sS --http1.1 --max-time 3 --output /dev/null --write-out '%{http_code}' \
    --resolve "$DOMAIN:443:127.0.0.1" -H "Origin: https://$DOMAIN" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "https://$DOMAIN/socket.io/?EIO=4&transport=websocket" 2>/dev/null || true)
[[ "$ws_status" == 101 ]] || fail "WebSocket upgrade failed (HTTP ${ws_status:-none})"
http_status=$(curl -sS --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" -o /dev/null -w '%{http_code}' "http://$DOMAIN/" 2>/dev/null || true)
[[ "$http_status" == 301 ]] || fail "HTTP-to-HTTPS redirect failed"

{
    echo "status=deployed"
    echo "domain=https://$DOMAIN"
    echo "database_backup=$BACKUP_DIR/$backup_name"
    echo "migration=$migration"
    echo "api_health=ok"
    echo "frontend_health=ok"
    echo "socketio_websocket_http=$ws_status"
    echo "http_redirect=$http_status"
    echo "nginx_reload=success"
    echo "certbot_renewal_dry_run=success"
} > "$REPORT"
chmod 644 "$REPORT"
echo "DEPLOYMENT_COMPLETE: https://$DOMAIN"
echo "REPORT=$REPORT"
echo "DATABASE_BACKUP=$BACKUP_DIR/$backup_name"
