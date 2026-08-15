#!/bin/sh
# Clawd Deck hook emitter. Called by Claude Code hooks with the event name as $1
# and the hook JSON payload on stdin. Fire-and-forget: if the Deck server is down,
# this exits instantly and the Claude session never notices.
payload=$(cat)
(
  curl -s --max-time 1 \
    -X POST \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    "http://localhost:4839/hook/${1:-unknown}" >/dev/null 2>&1 &
)
exit 0
