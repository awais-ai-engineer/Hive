#!/usr/bin/env bash
set -Eeuo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$DIR/../.." && pwd)"
STAGE="$DIR/.vercel-staging"
ENV_FILE="$DIR/.env"
SERVER_ENV="$DIR/server.env"
ORIGIN="https://hive-connect.vercel.app"
LEGACY="https://hive.blackbox-n8n.duckdns.org"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_IMAGE="hive-api:rollback-$STAMP"
COMPOSE=(sudo docker compose --project-directory "$DIR" --env-file "$ENV_FILE" -f "$DIR/compose.yaml")
FILES=(
  apps/server/app/auth/router.py
  apps/server/app/core/config.py
  apps/server/app/main.py
  apps/server/app/messages/service.py
  apps/server/app/realtime/socket.py
)

[[ -f "$ENV_FILE" && -f "$SERVER_ENV" && -f "$DIR/compose.yaml" ]] || { echo "Existing Hive deployment files missing; stopping." >&2; exit 2; }
for f in "${FILES[@]}"; do [[ -f "$STAGE/$f" ]] || { echo "Missing staged API file: $f" >&2; exit 2; }; done
[[ -f "$STAGE/deploy/vps/compose.yaml" ]] || { echo "Missing staged Hive Compose file." >&2; exit 2; }

echo "This rebuilds/restarts only the Hive API. Redis, moderation, web, Nginx, n8n, OpenClaw, and data are untouched."
echo "Sudo will prompt for the existing administrator password."
sudo -v
CURRENT_API_CONTAINER="$("${COMPOSE[@]}" ps -q api)"
if [[ -n "$CURRENT_API_CONTAINER" ]]; then
  echo "Current restored API container status:"
  sudo docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$CURRENT_API_CONTAINER"
  sudo docker logs --tail 80 "$CURRENT_API_CONTAINER" 2>&1 | grep -Ei 'alembic|uvicorn|application startup|error|traceback|failed|ready' | tail -n 40 | sed -E 's#(://)[^/@:]+:[^/@]+@#\1[redacted]@#g; s/(secret|token|password)([=: ]+)[^ ]+/\1\2[redacted]/Ig' || true
fi
read -r -p "Google OAuth Web Client ID from Google Cloud: " GOOGLE_CLIENT_ID
read -r -s -p "Freshly rotated Google OAuth client secret (hidden; do not paste in chat): " GOOGLE_CLIENT_SECRET
printf '\n'
[[ "$GOOGLE_CLIENT_ID" == *.apps.googleusercontent.com ]] || { echo "Invalid Google Web OAuth client ID format." >&2; exit 2; }
[[ ${#GOOGLE_CLIENT_SECRET} -ge 20 ]] || { echo "Client secret is empty or too short." >&2; exit 2; }

BACKUP="$STAGE/backups/$STAMP"
mkdir -p "$BACKUP"
for f in "${FILES[@]}"; do install -D -m 0644 "$ROOT/$f" "$BACKUP/$f"; done
cp -p "$DIR/compose.yaml" "$BACKUP/compose.yaml"
cp -p "$ENV_FILE" "$BACKUP/.env"
cp -p "$SERVER_ENV" "$BACKUP/server.env"
chmod 0600 "$BACKUP/server.env"
OLD_IMAGE="$("${COMPOSE[@]}" images -q api | head -n 1)"
[[ -n "$OLD_IMAGE" ]] || { echo "Could not identify the current Hive API image; stopping." >&2; exit 3; }
sudo docker image tag "$OLD_IMAGE" "$ROLLBACK_IMAGE"

for f in "${FILES[@]}"; do install -D -m 0644 "$STAGE/$f" "$ROOT/$f"; done
install -m 0644 "$STAGE/deploy/vps/compose.yaml" "$DIR/compose.yaml"
python3 - "$ENV_FILE" "$ORIGIN" "$LEGACY" <<'PY'
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
lines = [line for line in lines if not line.startswith(("WEB_ORIGIN=", "WEB_ORIGINS="))]
lines += [f"WEB_ORIGIN={sys.argv[2]}", f"WEB_ORIGINS={sys.argv[3]}"]
fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".hive-env.")
os.write(fd, ("\n".join(lines) + "\n").encode())
os.fchmod(fd, 0o600)
os.close(fd)
os.replace(temporary, path)
PY
printf '%s\0%s\0' "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" | python3 -c 'import os,pathlib,sys,tempfile; p=pathlib.Path(sys.argv[1]); client_id,secret=sys.stdin.buffer.read().split(b"\0")[:2]; lines=p.read_bytes().splitlines(); keys=(b"GOOGLE_CLIENT_ID=",b"GOOGLE_CLIENT_SECRET="); lines=[line for line in lines if not line.startswith(keys)]; lines.extend([keys[0]+client_id,keys[1]+secret]); fd,tmp=tempfile.mkstemp(dir=p.parent,prefix=".server.env."); os.write(fd,b"\n".join(lines)+b"\n"); os.fchmod(fd,0o600); os.close(fd); os.replace(tmp,p)' "$SERVER_ENV"
unset GOOGLE_CLIENT_SECRET GOOGLE_CLIENT_ID

rollback() {
  echo "Health/CORS verification failed; restoring the previous Hive API image and config." >&2
  for f in "${FILES[@]}"; do install -D -m 0644 "$BACKUP/$f" "$ROOT/$f"; done
  cp -p "$BACKUP/compose.yaml" "$DIR/compose.yaml"
  cp -p "$BACKUP/.env" "$ENV_FILE"
  cp -p "$BACKUP/server.env" "$SERVER_ENV"
  chmod 0600 "$SERVER_ENV"
  printf 'services:\n  api:\n    image: %s\n' "$ROLLBACK_IMAGE" > "$BACKUP/compose.rollback.yaml"
  "${COMPOSE[@]}" -f "$BACKUP/compose.rollback.yaml" up -d --no-deps --force-recreate --no-build api || true
  echo "Previous API image/config restored; no other services were touched." >&2
  exit 4
}

"${COMPOSE[@]}" config --quiet || rollback
"${COMPOSE[@]}" build api || rollback
"${COMPOSE[@]}" up -d --no-deps --force-recreate api || rollback

# Compose's "Started" means the container process launched, not that FastAPI's
# lifespan and health route are ready. Give it a bounded startup window.
API_CONTAINER="$("${COMPOSE[@]}" ps -q api)"
[[ -n "$API_CONTAINER" ]] || rollback
API_READY=0
for attempt in $(seq 1 90); do
  API_STATE="$(sudo docker inspect --format '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || true)"
  API_HEALTH="$(sudo docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$API_CONTAINER" 2>/dev/null || true)"
  if [[ "$API_STATE" == "running" && "$API_HEALTH" == "healthy" ]] && curl --fail --silent --max-time 5 http://127.0.0.1:4000/api/health >/dev/null; then
    API_READY=1
    break
  fi
  if [[ "$API_STATE" == "exited" || "$API_STATE" == "dead" ]]; then
    echo "Hive API container stopped during startup; automatic rollback follows." >&2
    break
  fi
  sleep 2
done
if [[ "$API_READY" != "1" ]]; then
  echo "Hive API did not become healthy within 180 seconds. Filtered startup diagnostics:" >&2
  sudo docker inspect --format 'state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$API_CONTAINER" 2>/dev/null || true
  sudo docker logs --tail 120 "$API_CONTAINER" 2>&1 | grep -Ei 'alembic|uvicorn|application startup|error|traceback|failed|ready' | tail -n 60 | sed -E 's#(://)[^/@:]+:[^/@]+@#\1[redacted]@#g; s/(secret|token|password)([=: ]+)[^ ]+/\1\2[redacted]/Ig' || true
  rollback
fi
echo "API readiness passed (container health is healthy). Checking CORS separately."

PREFLIGHT="$(curl --silent --show-error --max-time 10 -i -X OPTIONS http://127.0.0.1:4000/api/health -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization,content-type')" || rollback
grep -Fqi "access-control-allow-origin: $ORIGIN" <<<"$PREFLIGHT" || rollback
SOCKET="$(curl --silent --show-error --max-time 10 -i 'http://127.0.0.1:4000/socket.io/?EIO=4&transport=polling&t=origin-check' -H "Origin: $ORIGIN")" || rollback
grep -Fqi 'HTTP/1.1 200' <<<"$SOCKET" || grep -Fqi 'HTTP/2 200' <<<"$SOCKET" || rollback
grep -Fqi "access-control-allow-origin: $ORIGIN" <<<"$SOCKET" || rollback
OAUTH_HEADERS="$(curl --silent --show-error --max-time 10 -i http://127.0.0.1:4000/api/auth/google/start)" || rollback
grep -Fqi 'HTTP/1.1 303' <<<"$OAUTH_HEADERS" || grep -Fqi 'HTTP/2 303' <<<"$OAUTH_HEADERS" || rollback
grep -Fqi 'authError=unavailable' <<<"$OAUTH_HEADERS" && rollback
echo "Hive API healthy; Vercel CORS, Socket.IO polling, and Google OAuth configuration checks passed."
echo "Origins: $ORIGIN and $LEGACY"
echo "Rollback image retained: $ROLLBACK_IMAGE"
echo "A complete Google login still requires browser testing with an authorized test account."
