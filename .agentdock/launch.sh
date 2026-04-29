#!/usr/bin/env bash
set -euo pipefail

# AgentDock writes env vars to .env.agentdock at the workspace root before
# launching us. The SDK's startProcess({ env }) option doesn't reliably
# propagate to the spawned process, so source the file here as the source
# of truth.
if [ -f .env.agentdock ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.agentdock
  set +a
fi

if [ ! -d node_modules ]; then
  echo "[agentdock-agent] installing deps (idempotent)..."
  bun install --silent
fi

echo "[agentdock-agent] starting on 0.0.0.0:${PORT:-8080} model=${MODEL:-unset}"
exec bun run server.ts
