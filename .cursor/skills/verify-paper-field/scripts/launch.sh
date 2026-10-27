#!/usr/bin/env bash
# Start `npm run dev` on 127.0.0.1:43173, or reuse the server this skill already started.
# Exit 0 when this invocation started it, 10 when it was already ours, 2 when a foreign process owns the port.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"
mkdir -p "$PF_EVIDENCE"

if leader=$(pf_our_leader); then
  echo "already-running pid ${leader}"
  exit 10
fi

if pf_port_open; then
  echo "refusing: ${PF_URL} is already served by a process this skill did not start." >&2
  pids=$(pf_port_pids || true)
  if [[ -n "${pids}" ]]; then
    while read -r pid; do
      [[ -n "$pid" ]] || continue
      ps -p "$pid" -o pid=,user=,args= >&2 || true
    done <<< "$pids"
  else
    echo "A listener answered on ${PF_URL}, but lsof showed no pid. Not starting a second server." >&2
  fi
  exit 2
fi

if [[ ! -d "${PF_ROOT}/node_modules/vite" ]]; then
  echo "vite is not installed. From ${PF_ROOT} run: npm ci" >&2
  exit 1
fi

cd "$PF_ROOT"
# setsid: npm is the session leader, so cleanup can signal Vite's whole process group.
setsid npm run dev >"$PF_DEVLOG" 2>&1 </dev/null &
leader=$!
printf '%s\n' "$leader" > "$PF_PIDFILE"

for _ in $(seq 1 80); do
  if curl -fsS -o /dev/null --max-time 1 "${PF_URL}/" 2>/dev/null; then
    echo "started pid ${leader}"
    exit 0
  fi
  if ! kill -0 "$leader" 2>/dev/null; then
    echo "dev server exited before ${PF_URL} responded. Last log lines:" >&2
    tail -n 50 "$PF_DEVLOG" >&2 || true
    rm -f "$PF_PIDFILE"
    exit 1
  fi
  sleep 0.25
done

echo "timed out waiting for ${PF_URL}. Last log lines:" >&2
tail -n 50 "$PF_DEVLOG" >&2 || true
exit 1
