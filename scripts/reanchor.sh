#!/bin/bash
# After a deliberate reset of the demo data, accept the fresh audit chain as the new anchor.
cd "$(dirname "$0")/.."
CK=$(grep '^COUNTER_KEY=' .env | cut -d= -f2)
curl -s -m 20 -X POST http://127.0.0.1:8787/api/config -H "x-key: $CK" -H "content-type: application/json" -d '{"reanchor":true}' > /dev/null \
  && echo "audit anchor moved to the fresh chain" || echo "server not running: anchor not moved"
