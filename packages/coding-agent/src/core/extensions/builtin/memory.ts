import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { Type } from "typebox";
import { getPackageDir } from "../../../config.js";
import { getKernelVenvDir } from "../../kernel/bootstrap.js";
import type { MemorySettings } from "../../settings-manager.js";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "../types.js";

type MemorySettingsSnapshot = MemorySettings & {
	enabled: boolean;
	captureMode: "explicit" | "session-end" | "turn";
	maxRecallTokens: number;
	includeToolOutput: boolean;
	neo4jUser: string;
	neo4jPasswordEnv: string;
	llmApiKeyEnv: string;
	embeddingModel: string;
	embeddingApiKeyEnv: string;
};

type GraphitiItem = {
	id: string;
	name?: string;
	title?: string;
	fact?: string;
	content?: string;
	groupId?: string;
	episodes?: string[];
};

type GraphitiResponse = {
	ok: boolean;
	error?: string;
	workspace?: string;
	items?: GraphitiItem[];
	item?: GraphitiItem;
	id?: string;
};

const MAX_RECALL_ENTRIES = 5;
type ConfigureMemory = (settings: Partial<MemorySettings>) => void;

function configError(settings: MemorySettingsSnapshot): string | undefined {
	if (!settings.enabled) return "Graphiti memory is disabled. Set memory.enabled to true.";
	if (settings.provider !== "graphiti") return 'Graphiti memory is not selected. Set memory.provider to "graphiti".';
	if (!settings.endpoint) return "Set memory.endpoint to a Neo4j Bolt URI, for example bolt://localhost:7687.";
	if (!settings.llmModel) return "Set memory.llmModel to the model used for Graphiti entity extraction.";
	if (settings.captureMode !== "explicit")
		return 'Only explicit Graphiti capture is supported currently; set memory.captureMode to "explicit".';
	return undefined;
}

function pythonPath(): string {
	return process.env.PRIME_AGENT_KERNEL_PYTHON || join(getKernelVenvDir(), "bin", "python");
}

function runtimeSourcePath(): string {
	const packageDir = getPackageDir();
	return join(packageDir, "dist", "prime-agent-runtime", "src");
}

function runGraphiti(
	settings: MemorySettingsSnapshot,
	operation: "doctor" | "search" | "remember" | "forget",
	payload: Record<string, unknown> = {},
): Promise<GraphitiResponse> {
	const error = configError(settings);
	if (error) return Promise.resolve({ ok: false, error });
	return new Promise((resolve, reject) => {
		const child = spawn(pythonPath(), ["-m", "rlm.graphiti_memory"], {
			env: {
				...process.env,
				PYTHONPATH: [runtimeSourcePath(), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
			if (!line) {
				reject(new Error(stderr.trim() || `Graphiti bridge exited with code ${code ?? "unknown"}.`));
				return;
			}
			try {
				resolve(JSON.parse(line) as GraphitiResponse);
			} catch {
				reject(new Error(`Graphiti bridge returned invalid JSON: ${line.slice(0, 300)}`));
			}
		});
		child.stdin.end(JSON.stringify({ operation, config: settings, ...payload }));
	});
}

function itemText(item: GraphitiItem): string {
	const label = item.name || item.title || "Memory";
	const body = item.fact || item.content || "";
	return `Memory ID: ${item.id}\n  ${label}: ${body}`;
}

function formatGraphitiError(error: string): string {
	if (error.includes("environment variable")) {
		return `Graphiti is not ready: ${error}\nSet the variable, then run /memory doctor.`;
	}
	if (/(connect|connection|neo4j|bolt)/i.test(error)) {
		return `Graphiti could not connect to Neo4j: ${error}\nCheck that Neo4j is running at the configured Bolt URI, then run /memory doctor.`;
	}
	if (error.includes("No module named")) {
		return `${error}\nRestart Prime Agent so the Graphiti runtime dependency can be provisioned, then run /memory doctor.`;
	}
	return error;
}

function helpText(): string {
	return [
		"Graphiti memory",
		"",
		"Embedded graphiti-core stores memories in Neo4j. Capture is explicit only.",
		"",
		"Commands:",
		"  /memory status              Show configuration and readiness",
		"  /memory setup               Configure Neo4j and Graphiti interactively",
		"  /memory doctor              Test Neo4j, credentials, and Graphiti indexes",
		"  /memory list                List recent memories in the workspace",
		"  /memory search <query>      Search Graphiti facts",
		"  /memory remember <text>     Save an explicit memory",
		"  /memory forget <memory-id>  Delete a memory after confirmation",
		"",
		"Examples:",
		"  /memory remember This project uses pnpm",
		"  /memory search package manager",
		"  /memory forget 4f8c...",
		"",
		"Required configuration:",
		"  Neo4j Bolt URI and password",
		"  OpenAI-compatible Graphiti LLM and embedding credentials",
		"",
		"Set memory.captureMode to explicit. Automatic turn and session-end capture are not enabled.",
	].join("\n");
}

function statusText(settings: MemorySettingsSnapshot): string {
	const configuration = configError(settings);
	const neo4jPassword = process.env[settings.neo4jPasswordEnv] ? "set" : "missing";
	const llmKey = process.env[settings.llmApiKeyEnv] ? "set" : "missing";
	const missingSecrets = [
		neo4jPassword === "missing" ? settings.neo4jPasswordEnv : undefined,
		llmKey === "missing" ? settings.llmApiKeyEnv : undefined,
	].filter(Boolean);
	const problem =
		configuration ||
		(missingSecrets.length ? `Set environment variable(s): ${missingSecrets.join(", ")}.` : undefined);
	return [
		"Graphiti memory",
		`  Status: ${problem ? "Not ready" : "Configured (run /memory doctor)"}`,
		`  Provider: ${settings.provider || "not selected"}`,
		`  Neo4j: ${settings.endpoint || "not configured"}`,
		`  Workspace: ${settings.workspace || "prime-agent"}`,
		`  Capture: ${settings.captureMode}`,
		`  Recall budget: ${settings.maxRecallTokens} tokens`,
		`  Neo4j password (${settings.neo4jPasswordEnv}): ${neo4jPassword}`,
		`  Graphiti API key (${settings.llmApiKeyEnv}): ${llmKey}`,
		...(problem ? ["", `Next step: ${problem}`, "Run /memory setup for guided configuration."] : []),
	].join("\n");
}

function titleFor(content: string): string {
	const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine || "memory";
}

function searchTerms(query: string): string {
	return query.trim().slice(0, 2_000);
}

function notifyResponse(ctx: ExtensionContext, response: GraphitiResponse, emptyMessage: string): void {
	if (!response.ok) {
		ctx.ui.notify(formatGraphitiError(response.error || "Graphiti memory operation failed."), "error");
		return;
	}
	const items = response.items ?? [];
	ctx.ui.notify(items.length ? items.map(itemText).join("\n\n") : emptyMessage, "info");
}

export function createMemoryExtension(
	getSettings: () => MemorySettingsSnapshot,
	configureMemory: ConfigureMemory = () => {},
) {
	return function graphitiMemoryExtension(pi: ExtensionAPI): void {
		const setupMemory = async (ctx: ExtensionContext): Promise<void> => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Run /memory setup in interactive mode, or configure memory in settings.json.", "warning");
				return;
			}
			const current = getSettings();
			const ask = async (label: string, fallback: string): Promise<string | undefined> => {
				const value = await ctx.ui.input(label, fallback);
				if (value === undefined) return undefined;
				return value.trim() || fallback;
			};
			const endpoint = await ask("Neo4j Bolt URI", current.endpoint || "bolt://localhost:7687");
			if (endpoint === undefined) return;
			const workspace = await ask("Graphiti workspace", current.workspace || "prime-agent");
			if (workspace === undefined) return;
			const neo4jUser = await ask("Neo4j username", current.neo4jUser || "neo4j");
			if (neo4jUser === undefined) return;
			const neo4jPasswordEnv = await ask("Neo4j password environment variable", current.neo4jPasswordEnv);
			if (neo4jPasswordEnv === undefined) return;
			const llmModel = await ask("Graphiti extraction model", current.llmModel || "gpt-4o-mini");
			if (llmModel === undefined) return;
			const llmBaseUrl = await ask(
				"Graphiti OpenAI-compatible base URL (use default for OpenAI)",
				current.llmBaseUrl || "",
			);
			if (llmBaseUrl === undefined) return;
			const llmApiKeyEnv = await ask("Graphiti API key environment variable", current.llmApiKeyEnv);
			if (llmApiKeyEnv === undefined) return;
			const embeddingModel = await ask("Embedding model", current.embeddingModel || "text-embedding-3-small");
			if (embeddingModel === undefined) return;
			configureMemory({
				enabled: true,
				provider: "graphiti",
				captureMode: "explicit",
				endpoint,
				workspace,
				neo4jUser,
				neo4jPasswordEnv,
				llmModel,
				llmBaseUrl: llmBaseUrl || undefined,
				llmApiKeyEnv,
				embeddingModel,
			});
			ctx.ui.notify("Graphiti settings saved globally. Set the listed secrets, then run /memory doctor.", "info");
		};

		pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
			const settings = getSettings();
			if (configError(settings)) return;
			try {
				const response = await runGraphiti(settings, "search", { query: event.prompt });
				if (!response.ok) return;
				const items = (response.items ?? []).slice(0, MAX_RECALL_ENTRIES);
				const maxChars = Math.max(1_000, settings.maxRecallTokens * 4);
				let used = 0;
				const lines: string[] = [];
				for (const item of items) {
					const line = itemText(item);
					if (used + line.length > maxChars) break;
					lines.push(line);
					used += line.length;
				}
				if (lines.length === 0) return;
				return {
					systemPrompt: `${event.systemPrompt}\n\n<recalled_graphiti_memory>\n${lines.join("\n")}\n</recalled_graphiti_memory>`,
				};
			} catch {
				// Memory availability must never prevent a normal agent turn.
			}
		});

		pi.registerTool({
			name: "memory_remember",
			label: "Remember in Graphiti",
			description:
				"Save a durable fact, preference, decision, or outcome in the configured embedded Graphiti workspace.",
			parameters: Type.Object({
				title: Type.String({ description: "Short title for this memory" }),
				content: Type.String({ description: "Durable information to store" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const response = await runGraphiti(getSettings(), "remember", {
					title: params.title,
					content: params.content,
				});
				if (!response.ok) throw new Error(formatGraphitiError(response.error || "Graphiti memory capture failed."));
				return {
					content: [{ type: "text", text: `Saved Graphiti memory ${response.item?.id ?? "(unknown id)"}.` }],
					details: response.item ?? {},
				};
			},
		});

		pi.registerCommand("memory", {
			description: "Configure, search, and save memories in Graphiti; use /memory help for setup and commands",
			getArgumentCompletions: () => [
				{ value: "help", label: "help", description: "Show setup, commands, examples, and requirements" },
				{ value: "status", label: "status", description: "Show configuration, credentials, and readiness" },
				{ value: "setup", label: "setup", description: "Configure Neo4j and Graphiti interactively" },
				{ value: "doctor", label: "doctor", description: "Test Neo4j, credentials, and Graphiti indexes" },
				{ value: "list", label: "list", description: "List recent memories in the workspace" },
				{ value: "search", label: "search", description: "Search relevant Graphiti facts" },
				{ value: "remember", label: "remember", description: "Save an explicit Graphiti memory" },
				{ value: "forget", label: "forget", description: "Delete a memory after confirmation" },
			],

			handler: async (args, ctx) => {
				const trimmed = args.trim();
				const separator = trimmed.search(/\s/);
				const command = separator < 0 ? trimmed || "status" : trimmed.slice(0, separator);
				const rest = separator < 0 ? "" : trimmed.slice(separator).trim();
				const settings = getSettings();
				if (command === "help" || command === "--help" || command === "-h") {
					ctx.ui.notify(helpText(), "info");
					return;
				}
				if (command === "setup") {
					await setupMemory(ctx);
					return;
				}
				if (command === "status") {
					ctx.ui.notify(statusText(settings), "info");
					return;
				}

				try {
					if (command === "doctor") {
						const response = await runGraphiti(settings, "doctor");
						ctx.ui.notify(
							response.ok
								? `Graphiti is healthy. Workspace: ${response.workspace}`
								: formatGraphitiError(response.error || "Graphiti health check failed."),
							response.ok ? "info" : "error",
						);
						return;
					}
					if (command === "list") {
						notifyResponse(ctx, await runGraphiti(settings, "search"), "No Graphiti memories found.");
						return;
					}
					if (command === "search") {
						if (!rest) {
							ctx.ui.notify("Usage: /memory search <query>", "warning");
							return;
						}
						notifyResponse(
							ctx,
							await runGraphiti(settings, "search", { query: searchTerms(rest) }),
							"No matching Graphiti memories found.",
						);
						return;
					}
					if (command === "remember" || command === "add") {
						if (!rest) {
							ctx.ui.notify("Usage: /memory remember <text>", "warning");
							return;
						}
						const response = await runGraphiti(settings, "remember", { title: titleFor(rest), content: rest });
						ctx.ui.notify(
							response.ok
								? `Saved Graphiti memory ${response.item?.id ?? "(unknown id)"}.`
								: response.error || "Graphiti memory capture failed.",
							response.ok ? "info" : "error",
						);
						return;
					}
					if (command === "forget" || command === "delete") {
						if (!rest) {
							ctx.ui.notify("Usage: /memory forget <memory-id>", "warning");
							return;
						}
						if (!(await ctx.ui.confirm("Forget Graphiti memory", `Delete memory ${rest}?`))) return;
						const response = await runGraphiti(settings, "forget", { id: rest });
						ctx.ui.notify(
							response.ok ? `Deleted Graphiti memory ${rest}.` : response.error || "Graphiti delete failed.",
							response.ok ? "info" : "error",
						);
						return;
					}
					ctx.ui.notify(
						"Usage: /memory help | status | setup | doctor | list | search <query> | remember <text> | forget <memory-id>",
						"warning",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
}
