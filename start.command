#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js 22.13 or newer is required.'
  read '?Press Enter to close.'
  exit 1
fi
if curl --silent --max-time 2 http://127.0.0.1:4320/api/status | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("mode") != "public_sources_only")' 2>/dev/null; then
  open http://127.0.0.1:4320
  exit 0
fi
node server.js &
talent_platform_pid=$!
trap 'kill "$talent_platform_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..30}; do
  if ! kill -0 "$talent_platform_pid" 2>/dev/null; then break; fi
  if curl --silent --max-time 1 http://127.0.0.1:4320/api/status | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("mode") != "public_sources_only")' 2>/dev/null; then
    open http://127.0.0.1:4320
    break
  fi
  sleep 0.2
done
wait "$talent_platform_pid"
