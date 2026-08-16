import type { ExtensionAPI } from "../types.js";
import { Type } from "typebox";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { summarizeTiming } from "./jira-time-adapter.js";

const root = join(homedir(), ".prime", "agent", "state", "jira-time");
const file = join(root, "sessions.json");
const timingRoot = process.env.PRIME_TIMING_LOG?.endsWith(".jsonl")
  ? join(process.env.PRIME_TIMING_LOG, "..")
  : process.env.PRIME_TIMING_LOG ?? join(homedir(), ".local", "share", "prime-agent", "timing");
const IDLE_MS = 15 * 60 * 1000;
const round = (ms: number) => Math.max(0, Math.round(ms / 300000) * 300000);
type Row = {
  id: string; source: "prime-agent" | "external"; primeSessionId?: string;
  issue?: string; description?: string; started: string; last: string;
  activeMs: number; status: string; jiraWorklogId?: string;
};
async function load(): Promise<Row[]> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return []; } }
async function save(rows: Row[]) { await mkdir(root, { recursive: true }); await writeFile(file, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 }); }

export default function jiraTime(pi: ExtensionAPI) {
  const id = randomUUID(); let row: Row | undefined; let primeSessionId: string | undefined;
  const now = () => Date.now();
  const flush = () => { if (!row || row.status !== "active") return; const elapsed = now() - Date.parse(row.last); row.activeMs += Math.min(elapsed, IDLE_MS); row.last = new Date().toISOString(); };
  const persist = async () => { if (!row) return; flush(); const rows = await load(); const i = rows.findIndex(x => x.id === row!.id); if (i < 0) rows.push(row!); else rows[i] = row!; await save(rows); };
  const begin = async (issue?: string, description?: string) => { row = { id, source: "prime-agent", primeSessionId, issue, description, started: new Date().toISOString(), last: new Date().toISOString(), activeMs: 0, status: "active" }; await persist(); };
  const submitConfirmed = async (ctx: any) => {
    if (!row) return;
    flush(); row.status = "pending_confirmation"; await persist();
    const minutes = Math.round(round(row.activeMs) / 60000);
    const ok = await ctx.ui.confirm("Jira worklog", `Submit ${minutes} minutes for ${row.issue ?? "an unassigned session"}?`);
    if (!ok) { row.status = "local_pending"; await persist(); ctx.ui.notify("Kept locally; nothing was submitted to Jira.", "info"); return; }
    ctx.ui.notify("Confirmed. The agent will submit this through Atlassian MCP addWorklogToJiraIssue.", "info");
    pi.sendMessage({ customType: "jira-time", content: `Submit exactly this confirmed Jira time entry via the existing Atlassian MCP addWorklogToJiraIssue tool. Entry ${row.id}; issue ${row.issue ?? "missing"}; duration ${minutes} minutes; description ${row.description ?? "Prime Agent session work"}. Do not create or log anything else.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  };
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    primeSessionId = ctx.sessionManager.getSessionFile()?.split("/").pop()?.replace(/\.jsonl$/, "");
    const yes = await ctx.ui.confirm("Jira time tracking", "Track this session with a Jira story or ticket?");
    if (yes) { await begin(); ctx.ui.notify("Tracking enabled. Use /jira-time start ISSUE, /jira-time find, or /jira-time create.", "info"); }
    else ctx.ui.notify("Session is not tracked.", "info");
  });
  pi.on("session_shutdown", async () => { if (row?.status === "active") await persist(); });

  pi.registerTool({
    name: "jira_time_log_external", label: "Log external Jira time",
    description: "Add a manually supplied time entry for work done outside Prime Agent. The entry is stored locally and requires confirmation before Jira submission.",
    parameters: Type.Object({
      issue: Type.Optional(Type.String({ description: "Jira issue key, for example PFE-123" })),
      duration_minutes: Type.Number({ description: "Elapsed minutes; must be positive" }),
      description: Type.String({ description: "Short description of the external work" }),
      started_at: Type.Optional(Type.String({ description: "ISO timestamp, if known" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!Number.isFinite(params.duration_minutes) || params.duration_minutes <= 0) throw new Error("duration_minutes must be positive");
      const external: Row = { id: randomUUID(), source: "external", issue: params.issue, description: params.description, started: params.started_at ?? new Date().toISOString(), last: new Date().toISOString(), activeMs: params.duration_minutes * 60000, status: "local_pending" };
      const rows = await load(); rows.push(external); await save(rows);
      const ok = await ctx.ui.confirm("External Jira worklog", `Keep ${Math.round(params.duration_minutes)} minutes for ${params.issue ?? "an unassigned issue"} locally?`);
      if (!ok) { external.status = "discarded"; await save(rows); return { content: [{ type: "text", text: "External time entry discarded." }], details: {} }; }
      return { content: [{ type: "text", text: `Stored external time entry ${external.id} locally. Use /jira-time log ${external.id} after confirming the Jira issue.` }], details: external };
    },
  });

  pi.registerCommand("jira-time", { description: "Opt-in Jira time tracking", handler: async (args, ctx) => {
    const [cmd, value] = (args?.trim() ?? "status").split(/\s+/, 2);
    if (cmd === "start") { if (!row) await begin(value); else { row.issue = value; await persist(); } ctx.ui.notify(`Tracking ${value ?? "locally"}.`, "info"); return; }
    if (cmd === "status") { flush(); ctx.ui.notify(row ? `${row.status}; issue=${row.issue ?? "unassigned"}; ${(row.activeMs / 60000).toFixed(0)}m active` : "No tracked session.", "info"); return; }
    if (cmd === "associate") { if (!row) await begin(value); else row.issue = value; await persist(); ctx.ui.notify(`Associated with ${value}.`, "info"); return; }
    if (cmd === "find") { ctx.ui.notify("Ask the agent to search Jira using Atlassian MCP. If suggestions are rejected, choose Create new issue.", "info"); return; }
    if (cmd === "create") { ctx.ui.notify("Ask the agent to create a Jira Story through Atlassian MCP. Creation requires confirmation.", "info"); return; }
    if (cmd === "stop") { if (!row) { ctx.ui.notify("No tracked session.", "warning"); return; } await submitConfirmed(ctx); return; }
    if (cmd === "log" && value) { const rows = await load(); row = rows.find(x => x.id === value); if (!row) { ctx.ui.notify(`No local entry ${value}.`, "warning"); return; } await submitConfirmed(ctx); return; }
    if (cmd === "pending") { const pending = (await load()).filter(x => x.status === "local_pending" || x.status === "pending_confirmation"); ctx.ui.notify(pending.map(x => `${x.id}: ${Math.round(x.activeMs / 60000)}m ${x.issue ?? "unassigned"} (${x.source})`).join("\n") || "No pending entries.", "info"); return; }
    if (cmd === "report") { const summary = await summarizeTiming(timingRoot, await load()); ctx.ui.notify(summary, "info"); return; }
    if (cmd === "doctor") { let configured = false; try { const settings = JSON.parse(await readFile(join(homedir(), ".prime", "agent", "settings.json"), "utf8")) as { mcpServers?: Record<string, { enabled?: boolean; url?: string }> }; const a = settings.mcpServers?.atlassian; configured = Boolean(a?.enabled && a.url); } catch { /* settings may not exist yet */ } if (!configured) { ctx.ui.notify("Atlassian MCP preflight failed: configure mcpServers.atlassian in Prime Agent settings, then run /mcp login atlassian.", "warning"); return; } ctx.ui.notify("Atlassian MCP is configured. Ask the agent to verify Jira search, create-issue, and add-worklog tools; authentication can be repaired with /mcp login atlassian.", "info"); return; }
    ctx.ui.notify("Usage: /jira-time start ISSUE | status | associate ISSUE | find | create | stop | log ID | pending | report | doctor", "info");
  }});
}
