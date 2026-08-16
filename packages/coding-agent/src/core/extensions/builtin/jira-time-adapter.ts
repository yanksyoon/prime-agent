import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Row = { id: string; source: string; primeSessionId?: string; issue?: string; activeMs: number; status: string };
export async function summarizeTiming(root: string, jiraRows: Row[]): Promise<string> {
  const totals = new Map<string, number>();
  try {
    const files = (await readdir(root)).filter(name => name.endsWith(".jsonl"));
    for (const name of files) {
      let lines: string[]; try { lines = (await readFile(join(root, name), "utf8")).split("\n").filter(Boolean); } catch { continue; }
      for (const line of lines) { try { const r = JSON.parse(line) as { event?: string; session_id?: string; duration_ms?: number }; if (r.event === "session" && r.session_id) totals.set(r.session_id, (totals.get(r.session_id) ?? 0) + Number(r.duration_ms ?? 0)); } catch { /* skip malformed timing rows */ } }
    }
  } catch { /* timing extension is optional */ }
  const pending = jiraRows.filter(r => r.status === "local_pending" || r.status === "pending_confirmation");
  const timingMinutes = [...totals.values()].reduce((a, b) => a + b, 0) / 60000;
  const jiraMinutes = jiraRows.reduce((a, r) => a + r.activeMs, 0) / 60000;
  return `Adapter report\nPrime Agent timing: ${timingMinutes.toFixed(0)}m across ${totals.size} sessions\nJira time ledger: ${jiraMinutes.toFixed(0)}m across ${jiraRows.length} entries\nPending Jira entries: ${pending.length}`;
}
