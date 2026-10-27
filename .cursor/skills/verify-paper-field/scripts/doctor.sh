#!/usr/bin/env bash
# Report whether a browser-preview drive can run. Exit 1 when a required piece is missing or the port is foreign.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

fail=0
note() { printf '  %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }
ok() { printf '  ok   %s\n' "$1"; }

echo "verify-paper-field doctor"
echo "  repo   ${PF_ROOT}"
echo "  url    ${PF_URL}"
echo "  tools  ${PF_TOOLS}"

node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [[ "$node_major" -ge 20 ]]; then
  ok "node $(node -v)"
else
  bad "node 20+ required (found: $(node -v 2>/dev/null || echo missing))"
fi

if [[ -d "${PF_ROOT}/node_modules/vite" ]]; then
  ok "dependencies installed (node_modules/vite)"
else
  bad "run npm ci in ${PF_ROOT}"
fi

if [[ -d "${PF_TOOLS}/node_modules/playwright" ]]; then
  ok "playwright package in ${PF_TOOLS}"
else
  bad "run scripts/setup-tools.sh (Playwright is installed outside the repo)"
fi

chrome_bin=$(find "$PF_BROWSERS" -type f \( -name chrome -o -name chromium -o -name chrome-headless-shell \) 2>/dev/null | head -n 1 || true)
if [[ -n "$chrome_bin" && -x "$chrome_bin" ]]; then
  ok "chromium browser (${chrome_bin})"
else
  bad "chromium browser missing; rerun scripts/setup-tools.sh"
fi

if leader=$(pf_our_leader); then
  if curl -fsS -o /dev/null --max-time 2 "${PF_URL}/"; then
    ok "dev server already ours (pid ${leader}) and ${PF_URL} responds"
  else
    bad "pidfile points at pid ${leader} but ${PF_URL} did not respond"
  fi
elif pf_port_open; then
  bad "${PF_URL} is owned by a foreign process; launch.sh will refuse"
  pids=$(pf_port_pids || true)
  if [[ -n "${pids}" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      note "$(ps -p "$pid" -o pid=,args= 2>/dev/null || echo "pid ${pid}")"
    done <<< "$pids"
  fi
else
  ok "port ${PF_PORT} is free"
fi

if [[ -w "$PF_EVIDENCE" || ( ! -e "$PF_EVIDENCE" && -w "$(dirname "$PF_EVIDENCE")" ) ]]; then
  ok "evidence directory is writable (${PF_EVIDENCE})"
else
  bad "cannot write ${PF_EVIDENCE}"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "doctor: not ready"
  exit 1
fi
echo "doctor: ready"
exit 0
