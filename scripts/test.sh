#!/usr/bin/env bash
# Runs vitest without taking over a shared workstation (the owner's test-economy rules). On a
# desktop the run waits for one of the machine-wide test slots when `test-slot` is on PATH, and runs
# in a systemd scope that caps memory with no swap (swapping is what freezes a desktop) and gives
# the run a low CPU and I/O weight. CI, cloud sessions and machines without a user systemd run
# vitest bare. Usage: scripts/test.sh <vitest arguments>. TEST_MEMORY_MAX overrides the cap.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cmd=("$PWD/node_modules/.bin/vitest" "$@")
if [ -z "${CI:-}" ]; then
  if command -v systemd-run > /dev/null && systemd-run --user --scope --quiet true 2> /dev/null; then
    cmd=(systemd-run --user --scope --quiet
      -p MemoryMax="${TEST_MEMORY_MAX:-4G}" -p MemorySwapMax=0
      -p CPUWeight=20 -p IOWeight=20
      -- "${cmd[@]}")
  fi
  if command -v test-slot > /dev/null; then cmd=(test-slot "${cmd[@]}"); fi
fi

exec "${cmd[@]}"
