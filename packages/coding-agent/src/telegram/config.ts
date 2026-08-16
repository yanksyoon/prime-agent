import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.js";

export interface TelegramConfig {
	botToken: string;
	allowedUsers: string[];
	allowAllUsers?: boolean;
	homeChannel?: string;
	cwd?: string;
	requireMention?: boolean;
	botUsername?: string;
	sessions?: Record<string, string>;
}

export function telegramConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "telegram.json");
}

export function loadTelegramConfig(agentDir = getAgentDir()): TelegramConfig | undefined {
	try {
		const value = JSON.parse(readFileSync(telegramConfigPath(agentDir), "utf8")) as Partial<TelegramConfig>;
		if (typeof value.botToken !== "string" || !isValidTelegramBotToken(value.botToken)) return undefined;
		if (!Array.isArray(value.allowedUsers) || !value.allowedUsers.every((id) => /^\d+$/.test(String(id))))
			return undefined;
		if (value.allowAllUsers !== true && value.allowedUsers.length === 0) return undefined;
		const sessions = value.sessions;
		if (
			sessions !== undefined &&
			(!sessions ||
				typeof sessions !== "object" ||
				Array.isArray(sessions) ||
				Object.values(sessions).some((path) => typeof path !== "string"))
		)
			return undefined;
		return {
			botToken: value.botToken.trim(),
			allowedUsers: [...new Set(value.allowedUsers.map(String))],
			allowAllUsers: value.allowAllUsers === true,
			homeChannel: value.homeChannel === undefined ? undefined : String(value.homeChannel),
			cwd: typeof value.cwd === "string" ? value.cwd : undefined,
			requireMention: typeof value.requireMention === "boolean" ? value.requireMention : true,
			botUsername: typeof value.botUsername === "string" ? value.botUsername : undefined,
			sessions: sessions ?? {},
		};
	} catch {
		return undefined;
	}
}

export function saveTelegramConfig(config: TelegramConfig, agentDir = getAgentDir()): void {
	const path = telegramConfigPath(agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

export function isValidTelegramBotToken(token: string): boolean {
	return /^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}
