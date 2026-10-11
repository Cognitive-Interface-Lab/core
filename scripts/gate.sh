#!/usr/bin/env bash
# Compact verification gate: one verdict line per step, failures only.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0

run_step() {
  local step="$1"
  local log
  log="$(mktemp)"
  if pnpm -s "$step" >"$log" 2>&1; then
    echo "PASS $step"
  else
    failed=1
    echo "FAIL $step"
    grep -E 'error|Error|FAIL|✗|×|failed' "$log" | head -n 30
  fi
  rm -f "$log"
}

run_step typecheck
run_step lint
run_step test

exit "$failed"
