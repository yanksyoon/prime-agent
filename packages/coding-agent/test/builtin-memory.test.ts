import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import memoryExtension from "../src/core/extensions/builtin/memory.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";
import { loadHarnessState } from "../src/core/refinement/refinement.js";

function createMockPi() {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const tools = new Map<string, unknown>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, tools, entries };
}

function createContext(artifactDir: string) {
	const notifications: string[] = [];
	return {
		ctx: {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionArtifactDir: () => artifactDir,
			},
			ui: {
				notify: (message: string) => notifications.push(message),
				confirm: async () => true,
			},
		},
		notifications,
	};
}

describe("memory extension", () => {
	const cleanup: string[] = [];
	afterEach(() => {
		while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
	});

	it("registers commands and explicit memory capture", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "prime-memory-"));
		cleanup.push(artifactDir);
		const { pi, handlers, commands, tools, entries } = createMockPi();
		const { ctx, notifications } = createContext(artifactDir);
		memoryExtension(pi);

		expect(commands.has("memory")).toBe(true);
		expect(tools.has("memory_remember")).toBe(true);
		await commands.get("memory")!.handler("remember Project uses pnpm", ctx);
		expect(notifications[0]).toContain("Saved local memory project_uses_pnpm");
		expect(entries).toHaveLength(1);

		const state = loadHarnessState(join(artifactDir, "harness"), "local");
		expect(state.entries.memory.project_uses_pnpm?.content).toBe("Project uses pnpm");
		expect(JSON.parse(readFileSync(join(artifactDir, "harness", "harness_state.json"), "utf8")).schema).toBe(1);

		const result = (await handlers.get("before_agent_start")![0](
			{
				type: "before_agent_start",
				prompt: "Which package manager does this project use?",
				systemPrompt: "base",
			},
			ctx,
		)) as { systemPrompt?: string } | undefined;
		expect(result?.systemPrompt).toContain("<recalled_local_memory>");
		expect(result?.systemPrompt).toContain("Project uses pnpm");
	});

	it("refuses writes for in-memory sessions", async () => {
		const { pi, commands } = createMockPi();
		const { ctx, notifications } = createContext("");
		(ctx.sessionManager as { getSessionArtifactDir: () => string | undefined }).getSessionArtifactDir = () =>
			undefined;
		memoryExtension(pi);
		await commands.get("memory")!.handler("remember Do not persist", ctx);
		expect(notifications[0]).toContain("requires a persisted session");
	});
});
