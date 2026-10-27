#!/usr/bin/env bash
# Shared paths for verify-paper-field. Source this file; do not execute it.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "source this file; do not execute it" >&2
  exit 1
fi

_PF_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PF_ROOT=$(git -C "$_PF_SCRIPT_DIR" rev-parse --show-toplevel)
PF_HOST="${PF_HOST:-127.0.0.1}"
PF_PORT="${PF_PORT:-43173}"
PF_URL="http://${PF_HOST}:${PF_PORT}"
PF_TOOLS="${PF_VERIFY_TOOLS:-${HOME}/.cache/pf-verify-tools}"
PF_BROWSERS="${PF_TOOLS}/browsers"
PF_EVIDENCE="${PF_ROOT}/.cursor/skills/verify-paper-field/evidence"
PF_PIDFILE="${PF_EVIDENCE}/dev-server.pid"
PF_DEVLOG="${PF_EVIDENCE}/dev-server.log"

export PF_ROOT PF_HOST PF_PORT PF_URL PF_TOOLS PF_BROWSERS PF_EVIDENCE PF_PIDFILE PF_DEVLOG
# Keep the browser download next to the Playwright install, outside the repo.
export PLAYWRIGHT_BROWSERS_PATH="$PF_BROWSERS"

pf_port_pids() {
  lsof -nP -iTCP:"${PF_PORT}" -sTCP:LISTEN -Fp 2>/dev/null \
    | awk '/^p/ { print substr($0, 2) }' \
    | sort -u
}

pf_port_open() {
  if [[ -n "$(pf_port_pids)" ]]; then
    return 0
  fi
  # lsof only lists listeners we are allowed to see. A live HTTP response is still "taken".
  curl -fsS -o /dev/null --max-time 1 "${PF_URL}/" 2>/dev/null
}

pf_pid_cwd() {
  readlink -f "/proc/${1}/cwd" 2>/dev/null || true
}

pf_session_id() {
  ps -o sid= -p "$1" 2>/dev/null | tr -d '[:space:]'
}

# Session leader recorded by launch.sh, when that session still owns the port
# and its working directory is this checkout.
pf_our_leader() {
  [[ -f "$PF_PIDFILE" ]] || return 1
  local leader pid sid found=0
  leader=$(tr -d '[:space:]' < "$PF_PIDFILE")
  [[ "$leader" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$leader" 2>/dev/null || return 1
  [[ "$(pf_pid_cwd "$leader")" == "$PF_ROOT" ]] || return 1
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    sid=$(pf_session_id "$pid")
    if [[ "$sid" == "$leader" ]]; then
      found=1
      break
    fi
  done < <(pf_port_pids)
  [[ "$found" == 1 ]] || return 1
  printf '%s\n' "$leader"
}
