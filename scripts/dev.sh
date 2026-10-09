#!/usr/bin/env bash
# Starts the API (port 3000), which runs its own PostgreSQL, and the UI (port 5173) together.
# Ctrl-C stops both, and so does either one exiting on its own (for example the API failing
# to start), so a failed start is never left half-running.
set -u
cd "$(dirname "$0")/.."

if [ ! -f server/.env ] && [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "server/.env is missing. Create it with: cp server/.env.sample server/.env (then set OPENROUTER_API_KEY)" >&2
  exit 1
fi

set -m # one process group per job, so each tree (npm and the tools it starts) can be stopped as a whole

(cd server && exec npm run dev) &
server=$!
(cd ui && exec npm run dev) &
ui=$!

stop() {
  trap - EXIT INT TERM
  kill -- "-$server" "-$ui" 2>/dev/null
  wait 2>/dev/null
}
trap stop EXIT
trap 'stop; exit 130' INT TERM

while kill -0 "$server" 2>/dev/null && kill -0 "$ui" 2>/dev/null; do
  sleep 1
done
echo "One of the two processes stopped: stopping the other." >&2
exit 1
