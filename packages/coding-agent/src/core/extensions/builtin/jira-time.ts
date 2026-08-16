import type { ExtensionAPI } from "../types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = join(homedir(), ".prime", "agent", "state", "jira-time");
const file = join(root, "sessions.json");
const IDLE_MS = 15 * 60 * 1000;
const round = (ms: number) => Math.max(0, Math.round(ms / 300000) * 300000);
type Row = { id:string; issue?:string; started:string; last:string; activeMs:number; status:string; jiraWorklogId?:string };
async function load(): Promise<Row[]> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return []; } }
async function save(rows: Row[]) { await mkdir(root, { recursive:true }); await writeFile(file, JSON.stringify(rows, null, 2)+"\n", { mode:0o600 }); }

export default function jiraTime(pi: ExtensionAPI) {
  const id = randomUUID(); let row: Row | undefined;
  const now = () => Date.now();
  const flush = () => { if (!row) return; const elapsed = now()-Date.parse(row.last); row.activeMs += Math.min(elapsed, IDLE_MS); row.last = new Date().toISOString(); };
  const persist = async () => { if (!row) return; flush(); const rows = await load(); const i=rows.findIndex(x=>x.id===row!.id); if(i<0) rows.push(row!); else rows[i]=row!; await save(rows); };
  const begin = async (issue?: string) => { row={id, issue, started:new Date().toISOString(), last:new Date().toISOString(), activeMs:0, status:"active"}; await persist(); };
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "new") return;
    const yes = await ctx.ui.confirm("Jira time tracking", "Track this session with a Jira story or ticket?");
    if (yes) { await begin(); ctx.ui.notify("Tracking enabled. Use /jira-time start ISSUE, /jira-time find, or /jira-time create.", "info"); }
    else ctx.ui.notify("Session is not tracked.", "info");
  });
  pi.on("session_shutdown", async () => { if (row?.status === "active") await persist(); });
  pi.registerCommand("jira-time", { description:"Opt-in Jira time tracking", handler: async (args, ctx) => {
    const [cmd, value] = (args?.trim() ?? "status").split(/\s+/,2);
    if (cmd === "start") { if (!row) await begin(value); else { row.issue=value; await persist(); } ctx.ui.notify(`Tracking ${value ?? "locally"}.`, "info"); return; }
    if (cmd === "status") { flush(); ctx.ui.notify(row ? `${row.status}; issue=${row.issue ?? "unassigned"}; ${(row.activeMs/60000).toFixed(0)}m active` : "No tracked session.", "info"); return; }
    if (cmd === "associate") { if (!row) await begin(value); else row.issue=value; await persist(); ctx.ui.notify(`Associated with ${value}.`, "info"); return; }
    if (cmd === "find") { ctx.ui.notify("Ask the agent to search Jira using Atlassian MCP. If you reject the suggestions, choose Create new issue.", "info"); return; }
    if (cmd === "create") { ctx.ui.notify("Ask the agent to create a Jira Story through Atlassian MCP. Creation requires confirmation.", "info"); return; }
    if (cmd === "stop") { if (!row) { ctx.ui.notify("No tracked session.", "warning"); return; } await persist(); row.status="pending_confirmation"; const minutes=Math.round(round(row.activeMs)/60000); const ok=await ctx.ui.confirm("Jira worklog", `Submit ${minutes} minutes for ${row.issue ?? "an unassigned session"}?`); if(ok) { ctx.ui.notify("Confirmed. The agent will submit this through the existing Atlassian MCP addWorklogToJiraIssue tool.", "info"); pi.sendMessage({customType:"jira-time", content:`Submit the confirmed Jira time entry via existing Atlassian MCP. Session ${row.id}; issue ${row.issue ?? "missing"}; duration ${minutes} minutes. Do not create or log anything else.`, display:true}, {triggerTurn:true, deliverAs:"followUp"}); } else { row.status="local_pending"; await persist(); ctx.ui.notify("Kept locally; nothing was submitted to Jira.", "info"); } return; }
    if (cmd === "doctor") { ctx.ui.notify("Atlassian MCP is required. Verify the server and required Jira tools with the agent; run /mcp login atlassian if authentication is missing.", "info"); return; }
    ctx.ui.notify("Usage: /jira-time start ISSUE | status | associate ISSUE | find | create | stop | doctor", "info");
  }});
}
