import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

// Host-side timing: unlike a prompt or skill, this observes actual lifecycle events.
const logRoot = process.env.PRIME_TIMING_LOG ?? join(homedir(), ".local", "share", "prime-agent", "timing");
const dailyPath = (day: string) => process.env.PRIME_TIMING_LOG?.endsWith(".jsonl")
  ? join(dirname(logRoot), `${day}-${logRoot.split("/").pop()}`)
  : join(logRoot, `${day}.jsonl`);
const categoryConfigPath = process.env.PRIME_TIMING_CATEGORIES ?? join(homedir(), ".config", "prime-agent", "timing-categories.json");
const classifierCommand = process.env.PRIME_TIMING_CLASSIFIER_CMD;
const builtInCategories: Record<string, string[]> = {
  testing: ["test", "pytest", "jest", "vitest", "unittest", "coverage"],
  "version control": ["git", "github", "pull request", "commit", "branch", "merge"],
  "deployment/operations": ["deploy", "kube", "kubectl", "juju", "terraform", "ansible", "docker", "helm", "ci/cd"],
  "research/documentation": ["research", "search", "web", "documentation", "confluence", "jira"],
  debugging: ["debug", "trace", "exception", "error", "bug", "diagnos"],
  implementation: ["write", "edit", "mkdir", "touch", "refactor", "implement", "code"],
  programming: ["python", "javascript", "typescript", "node", "bash", "shell", "script"],
};
const wall = () => new Date().toISOString();
const mono = () => performance.now();
const redacted = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/(TOKEN|PASSWORD|SECRET|API[_-]?KEY|AUTHORIZATION)\s*=\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 4000);
};

// Preserve useful command/code inputs without logging arbitrary large or secret payloads.
function safeInput(value: unknown): unknown {
  if (typeof value === "string") return redacted(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(safeInput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 50).map(([key, item]) => [key, safeInput(item)]));
  }
  return value;
}

type Started = { at: string; mono: number; name: string; args?: unknown };

export default function timingExtension(pi: ExtensionAPI) {
  const sessionId = randomUUID();
  const starts = new Map<string, Started>();
  let sessionStart: Started | undefined;
  let activeTurns = 0;

  async function write(event: Record<string, unknown>) {
    const day = String(event.started_at ?? wall()).slice(0, 10);
    const path = dailyPath(day);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify({
      schema: 1, session_id: sessionId, recorded_at: wall(), ...event,
    }) + "\n", { mode: 0o600 });
  }

  async function nativeWork(target: string): Promise<Array<Record<string, unknown>>> {
    const result: Array<Record<string, unknown>> = [];
    const root = join(homedir(), ".prime", "agent", "sessions");
    let files: string[];
    try { files = (await readdir(root)).filter((name) => name.endsWith(".jsonl")); } catch { return result; }
    for (const name of files) {
      let entries: Array<Record<string, unknown>>;
      try { entries = (await readFile(join(root, name), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { continue; }
      const session = entries.find((e) => e.type === "session");
      const sessionId = String(session?.id ?? name.slice(0, -6));
      const calls = new Map<string, { timestamp: string; input: unknown; tool: string }>();
      for (const entry of entries) {
        const timestamp = String(entry.timestamp ?? "");
        if (timestamp.slice(0, 10) !== target || entry.type !== "message") continue;
        const message = (entry.message ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
        for (const block of content) {
          if (block.type === "toolCall") calls.set(String(block.id), { timestamp, input: block.arguments, tool: String(block.name) });
          if (message.role === "toolResult" && String(message.toolCallId) === String(block.toolCallId ?? message.toolCallId)) {
            const call = calls.get(String(message.toolCallId));
            if (!call) continue;
            const duration = Math.max(0, new Date(timestamp).getTime() - new Date(call.timestamp).getTime());
            result.push({ event: "native_tool", session_id: sessionId, tool_name: call.tool, input: call.input, duration_ms: duration });
          }
        }
      }
    }
    return result;
  }

  async function classify(row: Record<string, unknown>): Promise<{ kind: string; source: string }> {
    const text = JSON.stringify(row.input ?? row.command ?? "").toLowerCase();
    let categories: Record<string, string[]> = builtInCategories;
    try {
      const custom = JSON.parse(await readFile(categoryConfigPath, "utf8")) as { categories?: Record<string, string[]> };
      if (custom.categories) categories = { ...builtInCategories, ...custom.categories };
    } catch { /* optional configuration */ }
    for (const [kind, terms] of Object.entries(categories)) {
      if (terms.some((term) => text.includes(term.toLowerCase()))) return { kind, source: "rules" };
    }
    if (classifierCommand) {
      const result = await new Promise<string>((resolve) => {
        const child = spawn("/bin/sh", ["-lc", classifierCommand], { stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk.toString(); });
        child.on("close", () => resolve(output.trim()));
        child.on("error", () => resolve(""));
        child.stdin.end(JSON.stringify({ input: row.input, tool: row.tool_name }));
      });
      if (result) {
        try { return { kind: String((JSON.parse(result) as { category?: string }).category ?? result).slice(0, 100), source: "classifier" }; }
        catch { return { kind: result.slice(0, 100), source: "classifier" }; }
      }
    }
    return { kind: String(row.tool_name ?? row.event ?? "other"), source: "fallback" };
  }

  pi.on("session_start", async () => {
    sessionStart = begin("session", "session");
    await write({ event: "session_start", started_at: sessionStart.at });
  });

  pi.on("session_shutdown", async (event) => {
    await finish("session", { reason: event.reason });
  });

  pi.on("turn_start", async (event) => {
    activeTurns++;
    begin(`turn:${event.turnIndex}`, "turn", { turn_index: event.turnIndex });
  });

  pi.on("turn_end", async (event) => {
    activeTurns = Math.max(0, activeTurns - 1);
    await finish(`turn:${event.turnIndex}`, { turn_index: event.turnIndex });
  });

  pi.on("tool_execution_start", async (event) => {
    // Current Prime Agent versions expose tool parameters as `input`; older versions
    // used `args`, so support both to keep logs useful across upgrades.
    const input = (event as { input?: unknown; args?: unknown }).input
      ?? (event as { args?: unknown }).args;
    begin(`tool:${event.toolCallId}`, "tool", { tool_name: event.toolName, args: input });
  });

  pi.on("tool_execution_end", async (event) => {
    await finish(`tool:${event.toolCallId}`, {
      tool_name: event.toolName, is_error: event.isError,
    });
  });

  pi.on("user_bash", async (event) => {
    // user_bash is emitted before execution; the actual duration is covered by the
    // corresponding tool lifecycle where available, while this preserves provenance.
    await write({ event: "user_bash", command: redacted(event.command), cwd: event.cwd });
  });

  pi.registerCommand("timing", {
    description: "Show timing status or interpret a daily log (usage: /timing [today|YYYY-MM-DD])",
    handler: async (args, ctx) => {
      const day = (args?.trim() || "status").toLowerCase();
      if (day === "status") {
        ctx.ui.notify(`Daily timing logs: ${logRoot} | active turns: ${activeTurns}`, "info");
        return;
      }
      const target = day === "today" ? new Date().toISOString().slice(0, 10) : day;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
        ctx.ui.notify("Usage: /timing, /timing today, or /timing YYYY-MM-DD", "warning");
        return;
      }
      const path = dailyPath(target);
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = (await readFile(path, "utf8")).split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        ctx.ui.notify(`No timing log found for ${target}: ${path}`, "info");
        return;
      }
      const native = await nativeWork(target);
      // Native logs provide semantic tool inputs and session IDs; retain wrapper events for external scripts.
      const concreteRows = [...rows.filter((item) => String(item.event) === "script"), ...native];
      const durations = new Map<string, number>();
      const counts = new Map<string, number>();
      const sources = new Map<string, number>();
      const sessions = new Map<string, { duration: number; work: Map<string, number> }>();
      for (const row of rows.filter((item) => String(item.event) === "session")) {
        const id = String(row.session_id ?? "unknown");
        sessions.set(id, { duration: Number(row.duration_ms ?? 0), work: new Map() });
      }
      // Match concrete work events to their session_id; script wrapper events are external.
      for (const row of concreteRows) {
        const { kind, source } = await classify(row);
        const ms = Number(row.duration_ms ?? 0);
        durations.set(kind, (durations.get(kind) ?? 0) + ms);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        sources.set(`${kind} [${source}]`, (sources.get(`${kind} [${source}]`) ?? 0) + 1);
        const id = String(row.session_id ?? "external scripts");
        const session = sessions.get(id) ?? { duration: 0, work: new Map<string, number>() };
        session.work.set(kind, (session.work.get(kind) ?? 0) + ms);
        sessions.set(id, session);
      }
      const interpretation = [...durations.entries()].sort((a, b) => b[1] - a[1])
        .map(([kind, ms]) => `${kind}: ${(ms / 60000).toFixed(1)}m (${counts.get(kind)} events)`).join("\n") || "No tool/script work recorded.";
      const sessionSummary = [...sessions.entries()].map(([id, session]) => {
        const work = [...session.work.entries()].sort((a, b) => b[1] - a[1]).map(([kind, ms]) => `${kind} ${(ms / 60000).toFixed(1)}m`).join(", ") || "no concrete work";
        return `${id === "external scripts" ? id : `session ${id.slice(0, 8)}`} (${(session.duration / 60000).toFixed(1)}m): ${work}`;
      }).join("\n") || "none";
      const sourceSummary = [...sources.entries()].map(([name, count]) => `${name}=${count}`).join(", ");
      ctx.ui.notify(`${target} work interpretation\n${interpretation}\n\nBy session\n${sessionSummary}\n\nClassification: ${sourceSummary || "none"}\nLog: ${path}`, "info");
    },
  });
}
