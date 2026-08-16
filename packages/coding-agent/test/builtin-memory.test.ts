import { describe, expect, it } from "vitest";
import { createMemoryExtension } from "../src/core/extensions/builtin/memory.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import type { MemorySettings } from "../src/core/settings-manager.js";

type SettingsSnapshot = MemorySettings & {
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

function createMockPi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, unknown>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command);
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, tools };
}

function settings(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
	return {
		enabled: false,
		provider: "graphiti",
		captureMode: "explicit",
		endpoint: "bolt://localhost:7687",
		workspace: "prime-agent",
		maxRecallTokens: 1200,
		includeToolOutput: false,
		neo4jUser: "neo4j",
		neo4jPasswordEnv: "GRAPHITI_NEO4J_PASSWORD",
		llmModel: "gpt-4o-mini",
		llmApiKeyEnv: "GRAPHITI_LLM_API_KEY",
		embeddingModel: "text-embedding-3-small",
		embeddingApiKeyEnv: "GRAPHITI_LLM_API_KEY",
		...overrides,
	};
}

function createContext() {
	const notifications: string[] = [];
	return {
		ctx: { ui: { notify: (message: string) => notifications.push(message) } },
		notifications,
	};
}

describe("Graphiti memory extension", () => {
	it("registers the command and explicit capture tool", async () => {
		const state = settings();
		const { pi, commands, tools } = createMockPi();
		const { ctx, notifications } = createContext();
		createMemoryExtension(() => state)(pi);

		expect(commands.has("memory")).toBe(true);
		expect(tools.has("memory_remember")).toBe(true);
		await commands.get("memory")!.handler("status", ctx);
		expect(notifications[0]).toContain("Graphiti memory is disabled");
	});

	it("shows configured Graphiti status without contacting the database", async () => {
		const state = settings({ enabled: true });
		const { pi, commands } = createMockPi();
		const { ctx, notifications } = createContext();
		createMemoryExtension(() => state)(pi);

		await commands.get("memory")!.handler("status", ctx);
		expect(notifications[0]).toContain("Graphiti memory: configured");
		expect(notifications[0]).toContain("bolt://localhost:7687");
	});

	it("does not recall when Graphiti is disabled", async () => {
		const { pi, handlers } = createMockPi();
		createMemoryExtension(() => settings())(pi);
		const result = await handlers.get("before_agent_start")![0](
			{ prompt: "remembered fact", systemPrompt: "base" },
			{},
		);
		expect(result).toBeUndefined();
	});
});
