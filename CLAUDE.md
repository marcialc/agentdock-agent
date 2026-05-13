# CLAUDE.md — agentdock-agent

A tiny chat agent (~300 lines of TS + one HTML page) deployed by **AgentDock** into a **Cloudflare Sandbox** container. Intentionally thin and disposable: anything that needs to outlive a sandbox belongs in AgentDock, not here.

## Layout

```
server.ts            # Bun HTTP server + OpenAI-compatible tool-calling loop
public/index.html    # Single-file UI: inline CSS + JS, no build step
.agentdock/launch.sh # AgentDock launch contract (sources .env.agentdock, then `bun run server.ts`)
README.md            # User-facing description
```

The UI is one ~2500-line `index.html`. There is no bundler, no framework, no separate CSS/JS files. New UI work edits that file directly.

## Server (server.ts)

Stateless Bun HTTP server on `$PORT` (default 8080). Endpoints:

| Path | Notes |
| --- | --- |
| `GET /` | Serves `public/index.html`. |
| `POST /api/chat/stream` | NDJSON-streaming tool-calling loop against `OPENAI_API_BASE_URL` / `OPENAI_API_KEY`. Up to 12 tool rounds per turn. |
| `POST /api/shell` | Runs a raw shell command (used by the `!cmd` composer shortcut). |
| `GET /api/fs/list?path=…` | Directory listing. |
| `GET /api/fs/read?path=…` | File read (UTF-8 or binary flag). |

Tools the model can call: `shell`, `read_file`, `write_file`, `list_files`. No allowlist — the sandbox is ephemeral and isolated, so this is acceptable.

Env vars come from `.env.agentdock` (sourced by `launch.sh`):
- `PORT`, `OPENAI_API_BASE_URL`, `OPENAI_API_KEY`, `MODEL`.

## UI (public/index.html)

State lives in a single top-level `state` object (around the `// ---------- state ----------` marker). The `el(tag, attrs, ...children)` helper is the entire DOM library — `attrs.on*` registers event listeners, `attrs.html` sets innerHTML.

Architectural facts worth knowing before editing:

- **No conversation persistence.** `state.messages` lives in JS memory only; refresh wipes the thread. This is intentional given the sandbox lifetime. Persistence is an AgentDock concern (see "Where things belong" below).
- **Multi-file tabs.** `fileTabs[]` + `activeFilePath` drive a dynamic `<span id="file-tabs">` slot in the tabbar. `openFile(path)` focuses an existing tab if the file is already open instead of opening a duplicate. Each tab holds its own `data` and preview/source `mode`.
- **In-flight turns are abortable.** `state.abortController` is created in `send()`, threaded into `streamChat(...,signal)`, and aborted by `stopTurn()`. The in-thread "stop" button, double-Escape (within 400ms, off the composer), and `newChat()` all go through `stopTurn`. `AbortError` is swallowed silently — don't surface a banner for it.
- **Server-side abort is NOT wired.** Aborting on the client stops the browser from reading more bytes; `server.ts`'s tool loop will still finish the current model round and burn its tokens. Follow-up work.
- **`!cmd` composer escape.** Lines starting with `!` skip the model entirely and POST to `/api/shell`. Useful for quick sandbox pokes.
- **Mock fallback.** If `/api/chat/stream` is unreachable, `send()` falls through to `MOCK.responder` so the static HTML stays usable when served without a backend. Keep this path working when changing the stream loop.

## Where things belong

- **Inside this repo:** anything that's purely UI, or anything that should reset when a sandbox redeploys.
- **Inside AgentDock (not here):** chat persistence, user/project storage, anything that should survive a sandbox redeploy. The pattern: AgentDock injects env vars (e.g. `STORAGE_URL` + token) and this agent makes HTTP calls — same shape as the existing model-gateway integration.

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

## When testing UI changes

- Boot the server and exercise the feature in a real browser. Type-checks and syntax checks verify code, not behavior.
- If you can't actually drive the browser, say so explicitly — don't claim the UI works.
- Keep an eye on the mock fallback path (`MOCK.responder`) when touching `send()` / `streamChat()`.
