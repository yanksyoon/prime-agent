import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isValidTelegramBotToken,
	loadTelegramConfig,
	saveTelegramConfig,
	telegramConfigPath,
} from "../src/telegram/config.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-telegram-"));
	directories.push(directory);
	return directory;
}

describe("Telegram config", () => {
	it("validates bot tokens", () => {
		expect(isValidTelegramBotToken("123456789:ABCdefGHI_jklMNOpqrSTUvwxYZ12345")).toBe(true);
		expect(isValidTelegramBotToken("not-a-token")).toBe(false);
	});
	it("round-trips configuration with owner-only permissions", () => {
		const directory = temporaryDirectory();
		saveTelegramConfig(
			{
				botToken: "123456789:ABCdefGHI_jklMNOpqrSTUvwxYZ12345",
				allowedUsers: ["42"],
				sessions: { "42": "/session.jsonl" },
			},
			directory,
		);
		expect(loadTelegramConfig(directory)?.sessions?.["42"]).toBe("/session.jsonl");
		if (process.platform !== "win32") expect(statSync(telegramConfigPath(directory)).mode & 0o777).toBe(0o600);
	});
	it("fails closed when the allowlist schema is absent or invalid", () => {
		const directory = temporaryDirectory();
		mkdirSync(directory, { recursive: true });
		const token = "123456789:ABCdefGHI_jklMNOpqrSTUvwxYZ12345";
		writeFileSync(telegramConfigPath(directory), JSON.stringify({ botToken: token }));
		expect(loadTelegramConfig(directory)).toBeUndefined();
		writeFileSync(telegramConfigPath(directory), JSON.stringify({ botToken: token, allowedUsers: ["not-numeric"] }));
		expect(loadTelegramConfig(directory)).toBeUndefined();
		writeFileSync(telegramConfigPath(directory), JSON.stringify({ botToken: token, allowedUsers: [] }));
		expect(loadTelegramConfig(directory)).toBeUndefined();
		writeFileSync(
			telegramConfigPath(directory),
			JSON.stringify({ botToken: token, allowedUsers: [], allowAllUsers: true }),
		);
		expect(loadTelegramConfig(directory)?.allowAllUsers).toBe(true);
	});

	it("fails closed for malformed files", () => {
		const directory = temporaryDirectory();
		mkdirSync(directory, { recursive: true });
		writeFileSync(telegramConfigPath(directory), "{bad json");
		expect(loadTelegramConfig(directory)).toBeUndefined();
	});
});
