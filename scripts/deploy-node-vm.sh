#!/usr/bin/env bash
# Pull latest upstream main, rebase prod, deploy Floway Node target to the Azure VM,
# restart the systemd service, and run local + public smoke tests.
#
# Usage:
#   ./scripts/deploy-node-vm.sh            # fetch/rebase, deploy, test
#   ./scripts/deploy-node-vm.sh --no-pull  # deploy current prod only
#
# Optional env:
#   FLOWAY_VM_HOST=liuyue@20.78.255.121
#   FLOWAY_VM_DIR=/home/liuyue/floway
#   FLOWAY_VM_SERVICE=floway
#   FLOWAY_PUBLIC_URL=https://gw.xiaoyueyue.work
#   FLOWAY_SMOKE_API_KEY=<api key>         # defaults to first key from VM sqlite

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

VM_HOST=${FLOWAY_VM_HOST:-liuyue@20.78.255.121}
REMOTE_DIR=${FLOWAY_VM_DIR:-/home/liuyue/floway}
REMOTE_NEXT=${FLOWAY_VM_NEXT_DIR:-${REMOTE_DIR}.next}
REMOTE_PREV=${FLOWAY_VM_PREV_DIR:-${REMOTE_DIR}.prev}
SERVICE=${FLOWAY_VM_SERVICE:-floway}
PUBLIC_URL=${FLOWAY_PUBLIC_URL:-https://gw.xiaoyueyue.work}
NO_PULL=0

for arg in "$@"; do
  case "$arg" in
    --no-pull) NO_PULL=1 ;;
    -h|--help)
      sed -n '1,24p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require_clean_tree() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has uncommitted changes; commit/stash before deploying." >&2
    git status --short >&2
    exit 1
  fi
}

refresh_prod() {
  require_clean_tree
  run git fetch upstream main
  run git fetch origin
  run git checkout main
  run git merge --ff-only upstream/main
  run git push origin main
  run git checkout prod
  run git rebase main
  run git push --force-with-lease origin prod
}

build_archive() {
  local archive=$1
  run pnpm install --frozen-lockfile
  run pnpm --filter @floway-dev/platform-node run typecheck
  run pnpm run build:web
  git archive --format=tar HEAD | gzip -9 > "$archive"
}

remote_deploy() {
  local archive=$1
  printf '\n==> Uploading archive to %s:%s\n' "$VM_HOST" "$REMOTE_NEXT"
  ssh "$VM_HOST" "rm -rf '$REMOTE_NEXT' && mkdir -p '$REMOTE_NEXT'"
  cat "$archive" | ssh "$VM_HOST" "tar xzf - -C '$REMOTE_NEXT'"

  printf '\n==> Installing/building on VM and swapping release\n'
  ssh "$VM_HOST" \
    "REMOTE_DIR='$REMOTE_DIR' REMOTE_NEXT='$REMOTE_NEXT' REMOTE_PREV='$REMOTE_PREV' SERVICE='$SERVICE' bash -s" <<'REMOTE'
set -euo pipefail

cd "$REMOTE_NEXT"
pnpm install --frozen-lockfile
pnpm --filter @floway-dev/platform-node run typecheck
pnpm run build:web

if [ ! -f /home/liuyue/.config/floway/floway.env ]; then
  echo "Missing /home/liuyue/.config/floway/floway.env" >&2
  exit 1
fi

rm -rf "$REMOTE_PREV"
if [ -d "$REMOTE_DIR" ]; then mv "$REMOTE_DIR" "$REMOTE_PREV"; fi
mv "$REMOTE_NEXT" "$REMOTE_DIR"

if ! systemctl --user restart "$SERVICE"; then
  echo "Restart failed; rolling back release directory." >&2
  rm -rf "$REMOTE_DIR"
  if [ -d "$REMOTE_PREV" ]; then mv "$REMOTE_PREV" "$REMOTE_DIR"; fi
  systemctl --user restart "$SERVICE" || true
  exit 1
fi
sleep 3
if ! systemctl --user is-active --quiet "$SERVICE"; then
  echo "Service is not active after restart; rolling back release directory." >&2
  systemctl --user status "$SERVICE" --no-pager || true
  rm -rf "$REMOTE_DIR"
  if [ -d "$REMOTE_PREV" ]; then mv "$REMOTE_PREV" "$REMOTE_DIR"; fi
  systemctl --user restart "$SERVICE" || true
  exit 1
fi
REMOTE
}

remote_smoke_key() {
  ssh "$VM_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
source /home/liuyue/.config/floway/floway.env
node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.FLOWAY_DB_PATH ?? '/home/liuyue/floway-data/floway.db');
const row = db.prepare('select key from api_keys order by created_at limit 1').get();
if (!row?.key) process.exit(2);
console.log(row.key);
NODE
REMOTE
}

remote_smoke() {
  printf '\n==> Running VM-local smoke tests\n'
  ssh "$VM_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
source /home/liuyue/.config/floway/floway.env
API_KEY=$(node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.FLOWAY_DB_PATH ?? '/home/liuyue/floway-data/floway.db');
const row = db.prepare('select key from api_keys order by created_at limit 1').get();
if (!row?.key) process.exit(2);
console.log(row.key);
NODE
)

curl --noproxy '*' -fsS -o /dev/null -H "x-api-key: $API_KEY" http://127.0.0.1:8000/v1/models
curl --noproxy '*' -fsS -o /dev/null -X POST http://127.0.0.1:8000/responses \
  -H 'Content-Type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"model":"gpt-5.4","input":"reply VM_SMOKE_OK","stream":false}'
curl --noproxy '*' -k -fsS -o /dev/null --resolve gw.xiaoyueyue.work:443:127.0.0.1 https://gw.xiaoyueyue.work/
curl --noproxy '*' -k -fsS -o /dev/null --resolve gw.xiaoyueyue.work:443:127.0.0.1 -H "x-api-key: $API_KEY" https://gw.xiaoyueyue.work/v1/models
REMOTE
}

public_smoke() {
  printf '\n==> Running public smoke tests against %s\n' "$PUBLIC_URL"
  local key=${FLOWAY_SMOKE_API_KEY:-}
  if [ -z "$key" ]; then
    key=$(remote_smoke_key)
  fi
  curl -fsS -o /dev/null "$PUBLIC_URL/"
  curl -fsS -o /dev/null -H "x-api-key: $key" "$PUBLIC_URL/v1/models"
  curl -fsS -o /dev/null -X POST "$PUBLIC_URL/responses" \
    -H 'Content-Type: application/json' \
    -H "x-api-key: $key" \
    -d '{"model":"gpt-5.4","input":"reply PUBLIC_SMOKE_OK","stream":false}'
}

main() {
  if [ "$NO_PULL" -eq 0 ]; then
    refresh_prod
  else
    require_clean_tree
    run git checkout prod
  fi

  local archive
  archive=$(mktemp /tmp/floway-deploy.XXXXXX.tar.gz)
  trap 'rm -f "$archive"' EXIT

  build_archive "$archive"
  remote_deploy "$archive"
  remote_smoke
  public_smoke

  printf '\n✔ Floway Node VM deploy succeeded: %s\n' "$PUBLIC_URL"
}

main
