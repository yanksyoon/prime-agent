import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Row = { id: string; source: string; primeSessionId?: string; issue?: string; description?: string; activeMs: number; status: string };
type Timing = { sessionId: string; durationMs: number };
export async function readTimingSessions(root: string): Promise<Timing[]> {
  const totals = new Map<string, number>();
  try {
    const files = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
    for (const name of files) {
      let lines: string[]; try { lines = (await readFile(join(root, name), "utf8")).split("\n").filter(Boolean); } catch { continue; }
      for (const line of lines) { try { const r = JSON.parse(line) as { event?: string; session_id?: string; duration_ms?: number }; if (r.event === "session" && r.session_id) totals.set(r.session_id, (totals.get(r.session_id) ?? 0) + Number(r.duration_ms ?? 0)); } catch { /* skip malformed timing rows */ } }
    }
  } catch { /* timing extension is optional */ }
  return [...totals].map(([sessionId, durationMs]) => ({ sessionId, durationMs }));
}
export async function summarizeTiming(root: string, jiraRows: Row[]): Promise<string> {
  const timing = await readTimingSessions(root);
  const pending = jiraRows.filter(r => r.status === "local_pending" || r.status === "pending_confirmation");
  const timingMinutes = timing.reduce((a, b) => a + b.durationMs, 0) / 60000;
  const jiraMinutes = jiraRows.reduce((a, r) => a + r.activeMs, 0) / 60000;
  const joined = jiraRows.filter(r => r.primeSessionId).map(r => {
    const match = timing.find(t => t.sessionId === r.primeSessionId);
    return `${r.issue ?? "unassigned"}: ${Math.round(r.activeMs / 60000)}m Jira, ${match ? Math.round(match.durationMs / 60000) : 0}m timing`;
  });
  return `Adapter report\nPrime Agent timing: ${timingMinutes.toFixed(0)}m across ${timing.length} sessions\nJira time ledger: ${jiraMinutes.toFixed(0)}m across ${jiraRows.length} entries\nPending Jira entries: ${pending.length}${joined.length ? `\n\nJoined sessions\n${joined.join("\n")}` : ""}`;
}
