import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
	applyRefinementProposal,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	type HarnessEntry,
	type HarnessState,
	loadHarnessState,
	REFINEMENT_CUSTOM_TYPE,
	type RefinementEdit,
	saveHarnessState,
} from "../../refinement/refinement.js";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "../types.js";

const MAX_RECALL_ENTRIES = 5;
const MAX_RECALL_CHARS = 6_000;

type MemoryRecord = { entry: HarnessEntry; id: string };

function localStateDir(ctx: ExtensionContext): string {
	const artifactDir = ctx.sessionManager.getSessionArtifactDir();
	const stateDir = getLocalHarnessStateDir(artifactDir);
	if (!stateDir) {
		throw new Error("Memory requires a persisted session. Start a normal session before saving local memory.");
	}
	return stateDir;
}

function readState(ctx: ExtensionContext): { dir: string; state: HarnessState } {
	const dir = localStateDir(ctx);
	return { dir, state: loadHarnessState(dir, "local") };
}

function slug(raw: string): string {
	const value = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return value || "memory";
}

function titleFor(content: string): string {
	const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine || "memory";
}

function memoryRecords(ctx: ExtensionContext, state?: HarnessState): MemoryRecord[] {
	const current = state ?? readState(ctx).state;
	return Object.entries(current.entries.memory).map(([id, entry]) => ({ id, entry }));
}

function bareId(id: string): string {
	return id.replace(/^local:/, "");
}

function findMemory(ctx: ExtensionContext, id: string, state?: HarnessState): HarnessEntry | undefined {
	const normalizedId = bareId(id);
	return memoryRecords(ctx, state).find(({ id: entryId }) => entryId === normalizedId)?.entry;
}

function applyMemoryEdit(pi: ExtensionAPI, ctx: ExtensionContext, edit: RefinementEdit): HarnessEntry {
	const { dir, state } = readState(ctx);
	const result = applyRefinementProposal(
		state,
		{
			summary: `Explicit memory ${edit.action}`,
			rationale: "User or agent explicitly requested this memory change.",
			expectedOutcome: "The requested local memory change is persisted and available on the next turn.",
			edits: [edit],
		},
		{ id: `memory_${randomUUID()}`, scope: "local" },
	);
	const applied = result.appliedEdits[0];
	if (!applied?.applied) {
		throw new Error(applied?.error ?? `Unable to ${edit.action} memory.`);
	}
	result.harnessStatePath = getHarnessStatePath(dir);
	saveHarnessState(dir, state);
	pi.appendEntry(REFINEMENT_CUSTOM_TYPE, result);
	return applied.after ?? applied.before!;
}

function searchMemories(ctx: ExtensionContext, query: string): HarnessEntry[] {
	const stopWords = new Set(["a", "an", "and", "does", "for", "how", "in", "is", "of", "the", "this", "use", "which"]);
	const terms = query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 2 && !stopWords.has(term));
	return memoryRecords(ctx)
		.map(({ entry }) => entry)
		.filter(({ title, content, path }) => {
			const haystack = `${title} ${content} ${path}`.toLowerCase();
			return terms.length === 0 || terms.some((term) => haystack.includes(term));
		})
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function formatMemory(entry: HarnessEntry): string {
	return `[local:${entry.id}] ${entry.title}: ${entry.content.trim().replace(/\s+/g, " ")}`;
}

function parseTripleParts(raw: string, expected: number): string[] | undefined {
	const parts = raw.split(" :: ").map((part) => part.trim());
	return parts.length === expected && parts.every(Boolean) ? parts : undefined;
}

function usage(): string {
	return "Usage: /memory status | list [query] | remember <text> | show <id> | update <id> :: <title> :: <content> | forget <id>";
}

function status(ctx: ExtensionContext): string {
	try {
		const { dir, state } = readState(ctx);
		return `Local harness memory: ${Object.keys(state.entries.memory).length} entries\nStore: ${getHarnessStatePath(dir)}\nCapture: explicit only`;
	} catch (error) {
		return `Local harness memory: unavailable\n${error instanceof Error ? error.message : String(error)}`;
	}
}

export default function memoryExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		let matches: HarnessEntry[];
		try {
			matches = searchMemories(ctx, event.prompt).slice(0, MAX_RECALL_ENTRIES);
		} catch {
			return;
		}
		const lines: string[] = [];
		let used = 0;
		for (const entry of matches) {
			const line = formatMemory(entry);
			if (used + line.length > MAX_RECALL_CHARS) break;
			lines.push(line);
			used += line.length;
		}
		if (lines.length === 0) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<recalled_local_memory>\n${lines.join("\n")}\n</recalled_local_memory>`,
		};
	});

	pi.registerTool({
		name: "memory_remember",
		label: "Remember",
		description:
			"Save a durable local memory. Use only for stable facts, preferences, decisions, or outcomes the user would want recalled later.",
		promptSnippet:
			"Use memory_remember only for durable, user-approved facts; memory is stored in the current session's local harness file.",
		parameters: Type.Object({
			title: Type.String({ description: "Short stable title used as the memory id" }),
			content: Type.String({ description: "The durable fact, preference, decision, or outcome to remember" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const entry = applyMemoryEdit(pi, ctx, {
				action: "create",
				kind: "memory",
				id: slug(params.title),
				title: params.title,
				content: params.content,
				path: "general",
				metadata: { managedBy: "memory-extension" },
			});
			return { content: [{ type: "text", text: `Saved local memory ${entry.id}: ${entry.title}` }], details: entry };
		},
	});

	pi.registerCommand("memory", {
		description: "View and manage local harness memory",
		getArgumentCompletions: () => [
			{ value: "status", label: "status", description: "Show memory storage and capture policy" },
			{ value: "list", label: "list", description: "List or search memories" },
			{ value: "remember", label: "remember", description: "Save a durable memory" },
			{ value: "show", label: "show", description: "Show one memory" },
			{ value: "update", label: "update", description: "Update one memory" },
			{ value: "forget", label: "forget", description: "Delete one memory" },
		],
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const separator = trimmed.search(/\s/);
			const command = separator < 0 ? trimmed : trimmed.slice(0, separator);
			const rest = separator < 0 ? "" : trimmed.slice(separator).trim();
			if (!command || command === "status") {
				ctx.ui.notify(status(ctx), "info");
				return;
			}
			try {
				if (command === "list") {
					const entries = searchMemories(ctx, rest);
					ctx.ui.notify(entries.length ? entries.map(formatMemory).join("\n") : "No matching memories.", "info");
					return;
				}
				if (command === "remember" || command === "add") {
					if (!rest) {
						ctx.ui.notify("Usage: /memory remember <text>", "warning");
						return;
					}
					const entry = applyMemoryEdit(pi, ctx, {
						action: "create",
						kind: "memory",
						id: slug(titleFor(rest)),
						title: titleFor(rest),
						content: rest,
						path: "general",
						metadata: { managedBy: "memory-extension" },
					});
					ctx.ui.notify(`Saved local memory ${entry.id}: ${entry.title}`, "info");
					return;
				}
				if (command === "show") {
					const entry = findMemory(ctx, rest);
					ctx.ui.notify(entry ? formatMemory(entry) : `Memory ${rest} was not found.`, entry ? "info" : "warning");
					return;
				}
				if (command === "update") {
					const parts = parseTripleParts(rest, 3);
					if (!parts) {
						ctx.ui.notify("Usage: /memory update <id> :: <title> :: <content>", "warning");
						return;
					}
					const [id, title, content] = parts;
					const entry = applyMemoryEdit(pi, ctx, {
						action: "update",
						kind: "memory",
						id: bareId(id),
						title,
						content,
					});
					ctx.ui.notify(`Updated local memory ${entry.id}.`, "info");
					return;
				}
				if (command === "forget" || command === "delete") {
					if (!rest) {
						ctx.ui.notify("Usage: /memory forget <id>", "warning");
						return;
					}
					if (!findMemory(ctx, rest)) {
						ctx.ui.notify(`Memory ${rest} was not found.`, "warning");
						return;
					}
					if (!(await ctx.ui.confirm("Forget memory", `Delete local memory ${rest}?`))) return;
					applyMemoryEdit(pi, ctx, { action: "delete", kind: "memory", id: bareId(rest) });
					ctx.ui.notify(`Deleted local memory ${rest}.`, "info");
					return;
				}
				ctx.ui.notify(usage(), "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
