#!/usr/bin/env bash
# End-to-end verification of the IPC → Web-Audio playback + word-highlight seam.
# Boots the real app with a test utterance, then asserts that:
#   1. the renderer received each chunk and rendered it as word spans  ([r] hl render n=…)
#   2. each chunk's onended round-tripped back to main, finishing the loop ([main] speak-complete)
# Proves: generate → IPC Float32Array intact → AudioBuffer → start() → word-render → onended → playback-ended → done.
set -u
cd "$(dirname "$0")/.."
LOG=$(mktemp)

LOCALSPEECH_TEST="Hello world. This is a local text to speech test." npx electron . > "$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 40); do        # up to ~120s for first-run model download
  sleep 3
  grep -q "\[main\] speak-complete" "$LOG" && break
  kill -0 $PID 2>/dev/null || break
done
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "--- relevant log lines ---"
grep -E "\[main\] model ready|hl render n=|hl done|\[main\] speak-complete|load failed|generate:" "$LOG" || true

PLAYED=$(grep -c "hl render n=" "$LOG")
DONE=$(grep -c "\[main\] speak-complete" "$LOG")
rm -f "$LOG"

echo "--- result: chunks-rendered=$PLAYED, speak-complete=$DONE ---"
if [ "$PLAYED" -ge 2 ] && [ "$DONE" -ge 1 ]; then
  echo "PASS"; exit 0
else
  echo "FAIL"; exit 1
fi
