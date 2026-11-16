#!/usr/bin/env bash
# Per-file gate for hub-core: 85% lines, 75% functions (platform.rs excluded).
set -euo pipefail
cd "$(dirname "$0")/.."
json=$(cargo llvm-cov --locked -p hub-core --json --summary-only)
bad=$(printf '%s' "$json" | jq -r '
  .data[0].files[]
  | select(.filename | test("crates/hub-core/src/")) | select(.filename | test("/platform\\.rs$") | not)
  | select(.summary.lines.percent < 85 or .summary.functions.percent < 75)
  | "\(.filename): lines \(.summary.lines.percent)% functions \(.summary.functions.percent)%"')
if [ -n "$bad" ]; then
  echo "coverage below gate (85% lines, 75% functions):" >&2
  echo "$bad" >&2
  exit 1
fi
echo "coverage gate ok"
