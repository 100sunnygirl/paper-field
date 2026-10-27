#!/usr/bin/env bash
# Install Playwright into ~/.cache/pf-verify-tools. Does not touch the repo lockfile.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_env.sh"

PLAYWRIGHT_VERSION="${PF_PLAYWRIGHT_VERSION:-1.56.1}"
mkdir -p "$PF_TOOLS"
cd "$PF_TOOLS"

if [[ ! -f package.json ]]; then
  cat > package.json <<EOF
{
  "name": "pf-verify-tools",
  "private": true,
  "description": "Playwright install for paper-field browser verification. Lives outside the repo.",
  "dependencies": {
    "playwright": "${PLAYWRIGHT_VERSION}"
  }
}
EOF
fi

npm install --no-fund --no-audit --save-exact "playwright@${PLAYWRIGHT_VERSION}"
npx playwright install chromium

# sudo resets PATH, so npx has to be resolved in the caller's environment.
if [[ "$(id -u)" -eq 0 ]]; then
  npx playwright install-deps chromium
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n env "PATH=${PATH}" npx playwright install-deps chromium
else
  echo "Playwright system libraries were not installed (no root). If chromium fails to launch, rerun setup-tools.sh as a user who can sudo." >&2
fi

echo "playwright ready in ${PF_TOOLS} (browsers: ${PF_BROWSERS})"
