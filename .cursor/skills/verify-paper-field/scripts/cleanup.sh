#!/usr/bin/env bash
# Stop the dev server launch.sh started. Never signals a pid whose cwd is not this repo.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

if [[ ! -f "$PF_PIDFILE" ]]; then
  echo "no dev server pidfile"
  exit 0
fi

leader=$(tr -d '[:space:]' < "$PF_PIDFILE")
if [[ ! "$leader" =~ ^[0-9]+$ ]]; then
  echo "pidfile ${PF_PIDFILE} does not contain a pid" >&2
  exit 1
fi

if ! kill -0 "$leader" 2>/dev/null; then
  rm -f "$PF_PIDFILE"
  echo "dev server already stopped"
  exit 0
fi

cwd=$(pf_pid_cwd "$leader")
if [[ "$cwd" != "$PF_ROOT" ]]; then
  echo "refusing to kill pid ${leader}; cwd is '${cwd}', expected ${PF_ROOT}" >&2
  exit 1
fi

kill -TERM -- "-${leader}" 2>/dev/null || kill -TERM "$leader" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$leader" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$leader" 2>/dev/null; then
  kill -KILL -- "-${leader}" 2>/dev/null || kill -KILL "$leader" 2>/dev/null || true
fi
rm -f "$PF_PIDFILE"
echo "stopped pid ${leader}"
