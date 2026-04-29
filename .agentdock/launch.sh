#!/usr/bin/env bash
set -euo pipefail

# AgentDock launches this from the repo root inside the sandbox container.
# bun install already ran during the install phase if package.json was
# present; we just start the server.

if [ ! -d node_modules ]; then
  echo "[agentdock-agent] installing deps (idempotent)..."
  bun install --silent
fi

echo "[agentdock-agent] starting on 0.0.0.0:${PORT:-8080}"
exec bun run server.ts
