#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v uv >/dev/null || { echo 'uv is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Node.js and npm are required.' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(!((a===22&&b>=13)||a===24||a>=26)){console.error("Use Node 22.13+ (22.x), 24.x, or 26+.");process.exit(1)}'
uv sync --project "$PROJECT_ROOT/backend" --python 3.13 --locked --extra test
# Keep installs independent of a stale or differently owned global npm cache.
npm ci --prefix "$PROJECT_ROOT/frontend" --cache "$PROJECT_ROOT/.cache/npm"
