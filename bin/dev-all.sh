#!/bin/sh
# Run Vite dev server and browse backend concurrently.
# Kills Vite when the backend exits (or vice versa).

cleanup() {
  kill $VITE_PID 2>/dev/null
  wait $VITE_PID 2>/dev/null
}
trap cleanup EXIT

cd "$(dirname "$0")/.." || exit 1

# Start Vite in the background
(cd ui && pnpm run dev) &
VITE_PID=$!

# Run browse in the foreground — all script args are forwarded
node ./bin/dev.js browse "$@"
