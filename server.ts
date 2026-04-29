import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";

const PORT = Number(process.env.PORT || 8080);
const HOSTNAME = "0.0.0.0";
const BASE_URL = (process.env.OPENAI_API_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.OPENAI_API_KEY || "";
const DEFAULT_MODEL = process.env.MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TOOL_ROUNDS = 12;
const MAX_TOOL_OUTPUT = 8000;

const SYSTEM_PROMPT = `You are AgentDock-Agent, a minimal autonomous assistant running inside a Cloudflare Sandbox container.
You have access to four tools that operate on the sandbox filesystem:
- shell: run any shell command and read stdout/stderr/exit code
- read_file: read a file's contents
- write_file: create or overwrite a file
- list_files: list directory entries
Use them as needed. The sandbox is ephemeral and isolated — anything you do here doesn't affect the user's machine.
Be concise, run tools in parallel when independent, and stop when the task is done.`;

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

async function callModel(messages: ChatMessage[], model: string): Promise<ChatMessage> {
  if (!BASE_URL) {
    throw new Error("OPENAI_API_BASE_URL is not set in the sandbox env.");
  }
  if (!API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in the sandbox env.");
  }
  const url = `${BASE_URL}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_DEFS,
      tool_choice: "auto",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AI Gateway ${res.status}: ${text.slice(0, 800)}`);
  }
  let json: { choices?: Array<{ message: ChatMessage }> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`AI Gateway returned non-JSON: ${text.slice(0, 800)}`);
  }
  const message = json.choices?.[0]?.message;
  if (!message) {
    throw new Error(`AI Gateway response missing choices[0].message: ${text.slice(0, 800)}`);
  }
  return message;
}

interface RunResult {
  messages: ChatMessage[];
  finalText: string;
  toolEvents: Array<{ name: string; args: unknown; result: unknown }>;
}

async function runAgent(userMessages: ChatMessage[], model: string): Promise<RunResult> {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...userMessages];
  const toolEvents: RunResult["toolEvents"] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const reply = await callModel(messages, model);
    messages.push(reply);

    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      return { messages, finalText: reply.content ?? "", toolEvents };
    }

    for (const call of reply.tool_calls) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = {};
      }
      const result = await execTool(call.function.name, parsed);
      toolEvents.push({ name: call.function.name, args: parsed, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: clip(JSON.stringify(result)),
      });
    }
  }

  return {
    messages,
    finalText: "(stopped: max tool rounds reached)",
    toolEvents,
  };
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

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = (await req.json()) as { messages?: ChatMessage[]; model?: string };
        if (!Array.isArray(body.messages)) {
          return jsonError(400, "messages must be an array");
        }
        const result = await runAgent(body.messages, body.model || DEFAULT_MODEL);
        return Response.json(
          {
            reply: result.finalText,
            messages: result.messages,
            toolEvents: result.toolEvents,
          },
          { headers: corsHeaders() },
        );
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : String(err));
      }
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

console.log(`[agentdock-agent] listening on http://${HOSTNAME}:${PORT}, default model=${DEFAULT_MODEL}`);
