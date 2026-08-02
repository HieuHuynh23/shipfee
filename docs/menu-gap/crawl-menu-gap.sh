#!/usr/bin/env bash
# Crawl menu gap restaurants locally / on VPS
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-open}"
IDS_FILE="$ROOT/docs/menu-gap/ids-open.txt"
if [[ "$MODE" == "all" ]]; then
  IDS_FILE="$ROOT/docs/menu-gap/ids-all.txt"
fi
cd "$ROOT/server"
echo "Using $IDS_FILE"
ok=0; fail=0; total=0
while IFS= read -r id || [[ -n "${id:-}" ]]; do
  [[ -z "${id// }" ]] && continue
  total=$((total+1))
  echo ""
  echo "===== [$total] CRAWL $id ====="
  if node crawl_restaurant_menus.js --id="$id" --force --threads=1 --delay=2000; then
    ok=$((ok+1))
  else
    fail=$((fail+1))
    echo "WARN: crawl failed for $id"
  fi
  sleep 2
done < "$IDS_FILE"
echo ""
echo "DONE total=$total ok=$ok fail=$fail"
