#!/usr/bin/env bash
# Launch the browser preview (unless this skill already did) and drive one or more journeys.
# Usage: drive-smoke.sh [reading-shell|paper-list-and-notes|add-paper-manual|mark-reading-status|system-settings|reading-holds|all]
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${HERE}/_env.sh"

if [[ ! -d "${PF_TOOLS}/node_modules/playwright" ]]; then
  echo "Playwright is not installed. Run: ${HERE}/setup-tools.sh" >&2
  exit 2
fi

args=("$@")
if [[ ${#args[@]} -eq 0 ]]; then
  args=(reading-shell)
fi

set +e
launch_out=$("${HERE}/launch.sh")
launch_code=$?
set -e
printf '%s\n' "$launch_out"

started=0
case "$launch_code" in
  0) started=1 ;;
  10) started=0 ;;
  *) exit "$launch_code" ;;
esac

cleanup_on_exit() {
  local status=$?
  if [[ "$started" == 1 ]]; then
    "${HERE}/cleanup.sh" || true
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

node "${HERE}/drive.mjs" "${args[@]}"
