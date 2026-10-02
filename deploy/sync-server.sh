#!/usr/bin/env bash
# Brings the server checkout in line with origin/master and rebuilds.
# Run ON the server:  bash /root/6AM-Fresh/deploy/sync-server.sh   (or paste it).
# It refuses to discard anything that is not provably disposable.
set -euo pipefail

REPO="${REPO:-/root/6AM-Fresh}"
cd "$REPO"

echo "== fetch"
git fetch origin

echo "== local-only commits (origin/master..HEAD)"
LOCAL_ONLY=$(git log --format='%h %s' origin/master..HEAD)
echo "${LOCAL_ONLY:-<none>}"

# Only merge commits are disposable: they exist because someone ran `git pull`
# on the server. A real commit (one with a single parent) is somebody's work.
REAL=$(git log --no-merges --format='%h %s' origin/master..HEAD)
if [ -n "$REAL" ]; then
  echo
  echo "STOP: these are real commits that exist only on this server:"
  echo "$REAL"
  echo "Not resetting. Send this output to the developer."
  exit 1
fi

echo "== files modified on the server (these will be discarded)"
git status --short | grep -v '^??' || echo "<none>"

echo "== back up untracked config before touching anything"
mkdir -p /root/server-backup
for f in Frontend/.env.production Backend/.env; do
  [ -f "$f" ] && cp -p "$f" "/root/server-backup/$(echo "$f" | tr / _).$(date +%s)"
done

echo "== reset to origin/master (untracked files such as .env.production are kept)"
git reset --hard origin/master
git status -sb

echo "== backend install"
( cd Backend && npm ci --ignore-scripts && (npm rebuild sharp || true) )

echo "== frontend install + build"
( cd Frontend && npm ci --ignore-scripts && npm run build )

echo "== restart"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list
  pm2 reload "$REPO/deploy/ecosystem.config.cjs" || echo "pm2 reload failed: restart the processes shown above by name"
else
  echo "pm2 not found: restart the backend however it is run on this box"
fi

echo "== done: $(git log --oneline -1)"
