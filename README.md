# agentdock-minimal-agent

A tiny chat agent designed to be deployed by [AgentDock](../../README.md) into a
Cloudflare Sandbox container. It is intentionally small (~300 lines of
TypeScript) and self-contained: a Bun HTTP server, a single static HTML page,
and four tools the model can call.

## What it does

- Single-port HTTP server on `$PORT` (default 8080), bound to `0.0.0.0`.
- Plain dark chat UI at `/`.
- `/api/chat` runs an OpenAI-compatible tool-calling loop against the
  `OPENAI_API_BASE_URL` / `OPENAI_API_KEY` provided by AgentDock.
- Built-in tools the model can call:
  - `shell` — run any shell command in the sandbox.
  - `read_file` — read a UTF-8 text file.
  - `write_file` — create or overwrite a file.
  - `list_files` — list directory entries.
- Up to 12 tool rounds per turn before the loop bails.

## Env vars (set by AgentDock)

| Var | Purpose |
| --- | --- |
| `PORT` | Port to listen on. |
| `OPENAI_API_BASE_URL` | OpenAI-compatible endpoint, typically `<gateway>/openai`. |
| `OPENAI_API_KEY` | AI Gateway bearer token (currently lives inside the sandbox; see AgentDock README on the zero-secret-boundary regression). |
| `MODEL` | Default model id used when the request doesn't override it. |

## Local sanity check

```sh
bun install
PORT=8080 \
OPENAI_API_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai \
OPENAI_API_KEY=<token> \
MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast \
bun run server.ts
```

Then open `http://localhost:8080`.

## Deploy via AgentDock

1. Push this directory as its own GitHub repo (e.g. `marcialc/agentdock-agent`).
2. In the AgentDock launch form, paste your repo URL.
3. AgentDock clones the repo, runs `bun install`, then sees `.agentdock/launch.sh`
   and execs it. The agent boots and the preview URL becomes the chat UI.

## Files

```
.
├── .agentdock/launch.sh   # AgentDock launch contract
├── .gitignore
├── README.md
├── package.json
├── server.ts              # Bun HTTP server + tool loop
├── tsconfig.json
└── public/index.html      # Chat UI
```

## Limits and known caveats

- Conversation state lives in the browser only; reload loses history.
- Tool execution has no allowlist — the model can run any shell command in
  the sandbox. Acceptable because the sandbox is ephemeral and isolated.
- No streaming; each turn returns when the tool loop concludes or hits 12 rounds.
- Model id assumes OpenAI-compatible chat completion. For Workers AI models
  via Cloudflare AI Gateway use one that exposes the OpenAI route, or change
  the gateway path to a provider that does (`openai`, `anthropic`, etc.).
