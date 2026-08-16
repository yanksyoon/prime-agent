import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "../src/telegram/config.js";
import {
	assistantTextFromDaemonResponse,
	isTelegramMessageAddressed,
	isTelegramMessageAllowed,
	splitTelegramOutput,
} from "../src/telegram/gateway.js";
import type { TelegramMessage } from "../src/telegram/types.js";

const baseConfig: TelegramConfig = {
	botToken: "123456789:ABCdefGHI_jklMNOpqrSTUvwxYZ12345",
	allowedUsers: ["42"],
	botUsername: "prime_agent_bot",
	requireMention: true,
};
function message(userId = 42, type: TelegramMessage["chat"]["type"] = "private"): TelegramMessage {
	return { message_id: 1, date: 0, chat: { id: 10, type }, from: { id: userId, is_bot: false, first_name: "User" } };
}

describe("Telegram gateway routing", () => {
	it("fails closed for users outside the allowlist and opens only explicitly", () => {
		expect(isTelegramMessageAllowed(baseConfig, message(99))).toBe(false);
		expect(isTelegramMessageAllowed({ ...baseConfig, allowedUsers: [], allowAllUsers: true }, message(99))).toBe(
			true,
		);
	});
	it("requires a bot mention in groups but not direct messages", () => {
		expect(isTelegramMessageAddressed(baseConfig, message(42, "private"), "hello")).toBe(true);
		expect(isTelegramMessageAddressed(baseConfig, message(42, "group"), "hello")).toBe(false);
		expect(isTelegramMessageAddressed(baseConfig, message(42, "group"), "hello @Prime_Agent_Bot")).toBe(true);
	});
	it("unwraps the daemon assistant response shape", () => {
		expect(
			assistantTextFromDaemonResponse({
				type: "response",
				command: "get_last_assistant_text",
				success: true,
				data: { text: "done" },
			}),
		).toBe("done");
		expect(() =>
			assistantTextFromDaemonResponse({
				type: "response",
				command: "get_last_assistant_text",
				success: true,
				data: "wrong",
			}),
		).toThrow();
	});
	it("splits long output without breaking surrogate pairs", () => {
		const chunks = splitTelegramOutput(`${"a".repeat(3999)}😀tail`);
		expect(chunks.length).toBe(2);
		expect(chunks.join("")).toBe(`${"a".repeat(3999)}😀tail`);
		expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
	});
});
