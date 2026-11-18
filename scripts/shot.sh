#!/usr/bin/env bash
# Background screenshot of one app, never shown on screen.
#   scripts/shot.sh <browser|master> <name> [js-to-run-first] [delay-ms]
cd "$(dirname "$0")/.."
app=$1; name=$2; script=${3:-}; delay=${4:-4500}
rm -f "build/shots/$name".*
mkdir -p build/shots
if [ "$app" = "browser" ]; then
  RAVEN_HEADLESS=1 RAVEN_DATA_DIR="$PWD/build/dev-browser" RAVEN_SHOT="$PWD/build/shots/$name.png" RAVEN_SHOT_DELAY=$delay RAVEN_SHOT_SCRIPT="$script" timeout 90 node_modules/electron/dist/electron.exe build/raven-browser >/dev/null 2>&1
else
  RAVEN_HEADLESS=1 RAVEN_BIND=127.0.0.1 RAVEN_USER_DATA="$PWD/build/dev-master" RAVEN_SHOT="$PWD/build/shots/$name.png" RAVEN_SHOT_DELAY=$delay RAVEN_SHOT_SCRIPT="$script" timeout 90 node_modules/electron/dist/electron.exe build/master-server >/dev/null 2>&1
fi
for f in build/shots/$name.png.json build/shots/$name.png.error.txt; do [ -f "$f" ] && cat "$f"; done
ls build/shots/$name.png 2>/dev/null
