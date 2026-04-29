import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";

const PORT = Number(process.env.PORT || 8080);
const HOSTNAME = "0.0.0.0";
const BASE_URL = (process.env.OPENAI_API_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TOOL_ROUNDS = 12;
const MAX_TOOL_OUTPUT = 8000;

const AGENT_OWN_PORT = process.env.AGENTDOCK_AGENT_PORT || process.env.PORT || "8080";
const PREVIEW_BASE = process.env.AGENTDOCK_PREVIEW_BASE || "";

const SYSTEM_PROMPT = `You are AgentDock-Agent, a minimal autonomous assistant running inside a Cloudflare Sandbox container.

You have access to four tools that operate on the sandbox filesystem:
- shell: run any shell command and read stdout/stderr/exit code
- read_file: read a file's contents
- write_file: create or overwrite a file
- list_files: list directory entries

The sandbox is ephemeral and isolated — anything you do here doesn't affect the user's machine. Be concise, run tools in parallel when independent, and stop when the task is done. Available CLIs include \`bun\`, \`node\`, \`npm\`, \`npx\`, \`git\`, \`curl\`. Prefer \`bun\` over \`npm\` for installs and scripts (it's much faster and is what AgentDock provisioned).

WORKSPACE LAYOUT:
- \`/workspace/openclaw\` is THIS agent's own source code (server.ts, public/index.html, etc.). Do NOT read, modify, list, or operate on it unless the user explicitly asks you to introspect or change AgentDock-Agent itself.
- New projects you create or repos you clone go in sibling directories under \`/workspace/\` — e.g. \`/workspace/hello-world\`, \`/workspace/test-app\`, \`/workspace/<repo-name>\`.

WHEN ASKED TO CREATE / SCAFFOLD / "NEW <X> PROJECT":
- Skip exploration. Do NOT list or read \`/workspace/openclaw\` or its files. Go straight to the scaffolder.
- React + Vite:    \`cd /workspace && bun create vite <name> -- --template react-ts\`
- Vue + Vite:      \`cd /workspace && bun create vite <name> -- --template vue-ts\`
- Hono server:     \`cd /workspace && bun create hono <name>\`
- Next.js:         \`cd /workspace && bun create next-app <name>\` (heavier; only if the user asked for Next specifically)
- Plain Node/Bun:  \`mkdir -p /workspace/<name> && cd /workspace/<name> && bun init -y\`
- After scaffolding, \`cd /workspace/<name> && bun install\` (most scaffolders also install for you), then start the dev server on a non-conflicting port and hand the user the preview URL (see below).

LAUNCHING WEB SERVERS:
- Port ${AGENT_OWN_PORT} is already bound by this agent UI. NEVER start a child web server on ${AGENT_OWN_PORT} — pick 8081, 8082, 5174, 3001, etc.
- Set the port explicitly: \`PORT=8081 bun run server.ts\`, \`bun run dev -- --port 5174 --host 0.0.0.0\`, \`next dev -p 3001 -H 0.0.0.0\`. \`--host 0.0.0.0\` is required for Vite/Next so the proxy can reach it.
- Run in the background: append \` >/tmp/<name>.log 2>&1 &\` so you don't block. Tail the log if you need to debug.
- Verify it's actually listening before claiming success: \`sleep 1 && curl -sf http://localhost:<port>/ >/dev/null && echo OK || tail -c 2000 /tmp/<name>.log\`.${
  PREVIEW_BASE
    ? `
- Tell the user the preview URL: \`${PREVIEW_BASE}<port>/\`. AgentDock's path proxy reaches any port listening inside the container; the user opens that URL in their own browser to see the rendered UI.`
    : ""
}
- You cannot see rendered output yourself (no browser/screenshot tool). To validate, \`curl\` the URL and reason about the HTML/JSON, or hand the preview URL back to the user.`;

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "shell",
      description:
        "Run a shell command in the sandbox (sh -c). Returns stdout, stderr, and exit_code. Use for git, network probes, package installs, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          cwd: { type: "string", description: "Working directory. Defaults to current." },
          timeout_ms: { type: "number", description: "Hard timeout. Defaults to 30000." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the sandbox.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the sandbox with the given UTF-8 content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List entries in a directory. Returns name + size + isDir for each entry.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list. Defaults to current." },
        },
      },
    },
  },
];

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

async function execShell(args: { command: string; cwd?: string; timeout_ms?: number }): Promise<unknown> {
  return new Promise((resolve) => {
    const timeout = Math.min(Math.max(args.timeout_ms ?? 30_000, 1_000), 120_000);
    const proc = spawn("sh", ["-c", args.command], {
      cwd: args.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeout);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit_code: code,
        stdout: clip(stdout),
        stderr: clip(stderr),
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err.message });
    });
  });
}

async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "shell") {
      return await execShell(args as { command: string });
    }
    if (name === "read_file") {
      const path = String(args.path);
      const content = await Bun.file(path).text();
      return { content: clip(content) };
    }
    if (name === "write_file") {
      const path = String(args.path);
      const content = String(args.content);
      await Bun.write(path, content);
      return { ok: true, bytes: new TextEncoder().encode(content).byteLength };
    }
    if (name === "list_files") {
      const path = String(args.path ?? ".");
      const entries = await readdir(path);
      const detailed = await Promise.all(
        entries.map(async (entry) => {
          try {
            const st = await stat(`${path}/${entry}`);
            return { name: entry, isDir: st.isDirectory(), size: st.size };
          } catch {
            return { name: entry, isDir: false, size: -1 };
          }
        }),
      );
      return { entries: detailed };
    }
    return { error: `unknown tool: ${name}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface ModelReply {
  message: ChatMessage;
  // Preserved before we null `content` for tool_calls — surface this to the
  // UI as the model's reasoning between tool calls.
  text: string;
}

async function callModel(messages: ChatMessage[], model: string, round: number): Promise<ModelReply> {
  if (!BASE_URL) {
    throw new Error("OPENAI_API_BASE_URL is not set in the sandbox env.");
  }
  if (!API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in the sandbox env.");
  }
  const url = `${BASE_URL}/chat/completions`;
  const requestBody = JSON.stringify({
    model,
    messages,
    tools: TOOL_DEFS,
    tool_choice: "auto",
  });
  const reqId = `r${round}-${Date.now().toString(36)}`;
  log("callModel.request", {
    reqId,
    url,
    model,
    msgCount: messages.length,
    msgRoles: messages.map((m) => m.role),
    contentTypes: messages.map((m) => describeContent(m.content)),
    toolCallsCount: messages.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0),
    bodyBytes: requestBody.length,
  });
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: requestBody,
    });
  } catch (err) {
    log("callModel.fetchError", { reqId, message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  const text = await res.text();
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    log("callModel.error", {
      reqId,
      status: res.status,
      elapsedMs: elapsed,
      bodyPreview: text.slice(0, 4000),
      requestPreview: requestBody.slice(0, 2000),
    });
    throw new Error(`AI Gateway ${res.status}: ${text.slice(0, 4000)}`);
  }
  let json: { choices?: Array<{ message: ChatMessage }> };
  try {
    json = JSON.parse(text);
  } catch {
    log("callModel.nonJson", { reqId, status: res.status, elapsedMs: elapsed, bodyPreview: text.slice(0, 2000) });
    throw new Error(`AI Gateway returned non-JSON: ${text.slice(0, 2000)}`);
  }
  const message = json.choices?.[0]?.message;
  if (!message) {
    log("callModel.missingMessage", { reqId, status: res.status, elapsedMs: elapsed, bodyPreview: text.slice(0, 2000) });
    throw new Error(`AI Gateway response missing choices[0].message: ${text.slice(0, 2000)}`);
  }
  const originalText = extractText((message as { content?: unknown }).content);
  const normalized = normalizeAssistantMessage(message);
  log("callModel.response", {
    reqId,
    elapsedMs: elapsed,
    status: res.status,
    contentType: describeContent(normalized.content),
    textLen: originalText.length,
    toolCalls: (normalized.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name })),
  });
  return { message: normalized, text: originalText };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
          return String((c as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function describeContent(c: unknown): string {
  if (c === null) return "null";
  if (typeof c === "string") return `string(${c.length})`;
  if (Array.isArray(c)) return `array(${c.length})`;
  return typeof c;
}

function log(event: string, data: Record<string, unknown>): void {
  console.log(`[agentdock-agent] ${event} ${JSON.stringify(data)}`);
}

// Workers AI's OpenAI-compat may return `content` as an array of content
// blocks ({type:"text",text:"..."}); the same endpoint's input schema rejects
// array content on subsequent rounds. Flatten to a string. When `tool_calls`
// are present, OpenAI's schema requires `content: null`.
function normalizeAssistantMessage(raw: unknown): ChatMessage {
  const m = raw as ChatMessage & { content?: unknown };
  let content: string | null;
  if (Array.isArray(m.content)) {
    content = (m.content as Array<unknown>)
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
          return String((c as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  } else if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = null;
  }
  if (m.tool_calls && m.tool_calls.length > 0) {
    content = null;
  }
  return {
    role: m.role,
    content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  };
}

interface RunResult {
  messages: ChatMessage[];
  finalText: string;
  toolEvents: Array<{ name: string; args: unknown; result: unknown; ms?: number }>;
}

type AgentEvent =
  | { type: "start"; model: string; maxRounds: number }
  | { type: "round_start"; round: number }
  | { type: "model_call"; round: number }
  | { type: "model_text"; round: number; text: string }
  | { type: "tool_start"; round: number; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_done"; round: number; id: string; name: string; ms: number; result: unknown }
  | { type: "max_rounds"; round: number }
  | { type: "final"; reply: string; toolEvents: RunResult["toolEvents"]; messages: ChatMessage[] }
  | { type: "error"; message: string; stack?: string };

async function runAgent(
  userMessages: ChatMessage[],
  model: string,
  onEvent?: (event: AgentEvent) => void,
): Promise<RunResult> {
  const sanitized = userMessages.map(sanitizeIncomingMessage);
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...sanitized];
  const toolEvents: RunResult["toolEvents"] = [];
  log("runAgent.start", {
    model,
    incomingCount: userMessages.length,
    sanitizedRoles: sanitized.map((m) => m.role),
    sanitizedContentTypes: sanitized.map((m) => describeContent(m.content)),
  });
  onEvent?.({ type: "start", model, maxRounds: MAX_TOOL_ROUNDS });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    onEvent?.({ type: "round_start", round });
    onEvent?.({ type: "model_call", round });
    const { message: reply, text: replyText } = await callModel(messages, model, round);
    messages.push(reply);

    if (replyText.trim().length > 0) {
      onEvent?.({ type: "model_text", round, text: replyText });
    }

    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      const finalText = typeof reply.content === "string" ? reply.content : replyText;
      log("runAgent.done", { round, finalLen: finalText.length, toolEventCount: toolEvents.length });
      return { messages, finalText, toolEvents };
    }

    for (const call of reply.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch (err) {
        log("runAgent.toolArgsParseError", {
          round,
          tool: call.function?.name,
          rawPreview: String(call.function?.arguments ?? "").slice(0, 400),
          message: err instanceof Error ? err.message : String(err),
        });
        parsed = {};
      }
      log("runAgent.tool.start", { round, id: call.id, name: call.function.name, args: previewArgs(parsed) });
      onEvent?.({ type: "tool_start", round, id: call.id, name: call.function.name, args: parsed });
      const t0 = Date.now();
      const result = await execTool(call.function.name, parsed);
      const ms = Date.now() - t0;
      log("runAgent.tool.done", {
        round,
        id: call.id,
        name: call.function.name,
        elapsedMs: ms,
        resultPreview: previewResult(result),
      });
      onEvent?.({ type: "tool_done", round, id: call.id, name: call.function.name, ms, result });
      toolEvents.push({ name: call.function.name, args: parsed, result, ms });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: clip(JSON.stringify(result)),
      });
    }
  }

  log("runAgent.maxRounds", { rounds: MAX_TOOL_ROUNDS, toolEventCount: toolEvents.length });
  onEvent?.({ type: "max_rounds", round: MAX_TOOL_ROUNDS });
  return {
    messages,
    finalText: "(stopped: max tool rounds reached)",
    toolEvents,
  };
}

// Defensive: clients may have stored model replies from prior turns where
// `content` ended up as an array (Workers AI compat quirk). Flatten before we
// re-send so the gateway's strict input schema accepts the request.
function sanitizeIncomingMessage(msg: ChatMessage): ChatMessage {
  const m = msg as ChatMessage & { content?: unknown };
  let content: string | null;
  if (Array.isArray(m.content)) {
    content = (m.content as Array<unknown>)
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) {
          return String((c as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  } else if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = null;
  }
  if (m.tool_calls && m.tool_calls.length > 0) {
    content = null;
  }
  return {
    role: m.role,
    content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  };
}

function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 200) out[k] = `${v.slice(0, 200)}…(+${v.length - 200})`;
    else out[k] = v;
  }
  return out;
}

function previewResult(result: unknown): string {
  try {
    const s = JSON.stringify(result);
    return s.length > 400 ? `${s.slice(0, 400)}…(+${s.length - 400})` : s;
  } catch {
    return "(unserializable)";
  }
}

const INDEX_HTML = await Bun.file(`${import.meta.dir}/public/index.html`).text();

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(INDEX_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, model: DEFAULT_MODEL }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/api/fs/list" && req.method === "GET") {
      const path = url.searchParams.get("path") || "/workspace";
      try {
        const names = await readdir(path);
        const detailed = await Promise.all(
          names.map(async (name) => {
            try {
              const st = await stat(`${path}/${name}`);
              return { name, isDir: st.isDirectory(), size: st.size };
            } catch {
              return { name, isDir: false, size: -1 };
            }
          }),
        );
        detailed.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return Response.json({ path, entries: detailed }, { headers: corsHeaders() });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const msg = e?.message || String(err);
        if (e?.code === "ENOENT") return jsonError(404, msg);
        if (e?.code === "EACCES" || e?.code === "ENOTDIR") return jsonError(400, msg);
        return jsonError(500, msg);
      }
    }

    if (url.pathname === "/api/fs/read" && req.method === "GET") {
      const path = url.searchParams.get("path");
      if (!path) return jsonError(400, "path query param is required");
      try {
        const st = await stat(path);
        if (st.isDirectory()) return jsonError(400, "path is a directory");
        const size = st.size;
        const MAX_VIEWER_BYTES = 262_144; // 256 KB
        const f = Bun.file(path);
        const head = new Uint8Array(await f.slice(0, Math.min(size, 4096)).arrayBuffer());
        let isBinary = false;
        for (let i = 0; i < head.length; i++) {
          if (head[i] === 0) { isBinary = true; break; }
        }
        if (isBinary) {
          return Response.json({ path, size, binary: true, content: null }, { headers: corsHeaders() });
        }
        if (size > MAX_VIEWER_BYTES) {
          const slice = await f.slice(0, MAX_VIEWER_BYTES).text();
          return Response.json(
            { path, size, truncated: true, content: slice },
            { headers: corsHeaders() },
          );
        }
        const content = await f.text();
        return Response.json({ path, size, content }, { headers: corsHeaders() });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const msg = e?.message || String(err);
        if (e?.code === "ENOENT") return jsonError(404, msg);
        if (e?.code === "EACCES" || e?.code === "EISDIR") return jsonError(400, msg);
        return jsonError(500, msg);
      }
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const reqStart = Date.now();
      try {
        const body = (await req.json()) as { messages?: ChatMessage[]; model?: string };
        if (!Array.isArray(body.messages)) {
          return jsonError(400, "messages must be an array");
        }
        log("chat.request", {
          msgCount: body.messages.length,
          model: body.model || DEFAULT_MODEL,
          lastUser: previewLastUser(body.messages),
        });
        const result = await runAgent(body.messages, body.model || DEFAULT_MODEL);
        log("chat.response", {
          elapsedMs: Date.now() - reqStart,
          finalLen: result.finalText.length,
          toolEventCount: result.toolEvents.length,
          finalMsgCount: result.messages.length,
        });
        return Response.json(
          {
            reply: result.finalText,
            messages: result.messages,
            toolEvents: result.toolEvents,
          },
          { headers: corsHeaders() },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        log("chat.error", { elapsedMs: Date.now() - reqStart, message, stack });
        return jsonError(500, message);
      }
    }

    if (url.pathname === "/api/chat/stream" && req.method === "POST") {
      const reqStart = Date.now();
      let body: { messages?: ChatMessage[]; model?: string };
      try {
        body = (await req.json()) as { messages?: ChatMessage[]; model?: string };
      } catch {
        return jsonError(400, "request body must be valid JSON");
      }
      if (!Array.isArray(body.messages)) {
        return jsonError(400, "messages must be an array");
      }
      const messages = body.messages;
      const model = body.model || DEFAULT_MODEL;
      log("chat.stream.request", {
        msgCount: messages.length,
        model,
        lastUser: previewLastUser(messages),
      });

      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: AgentEvent) => {
            try {
              controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
            } catch (err) {
              log("chat.stream.enqueueError", {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          };
          try {
            const result = await runAgent(messages, model, send);
            send({
              type: "final",
              reply: result.finalText,
              toolEvents: result.toolEvents,
              messages: result.messages,
            });
            log("chat.stream.response", {
              elapsedMs: Date.now() - reqStart,
              finalLen: result.finalText.length,
              toolEventCount: result.toolEvents.length,
              finalMsgCount: result.messages.length,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            log("chat.stream.error", { elapsedMs: Date.now() - reqStart, message, stack });
            send({ type: "error", message, stack });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
          ...corsHeaders(),
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

function previewLastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const c = m.content;
      const s = typeof c === "string" ? c : Array.isArray(c) ? JSON.stringify(c) : "";
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    }
  }
  return "";
}

console.log(`[agentdock-agent] listening on http://${HOSTNAME}:${PORT}, default model=${DEFAULT_MODEL}`);
