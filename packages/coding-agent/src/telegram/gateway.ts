import chalk from "chalk";
import { ensureInteractiveDaemonRunning } from "../cli/daemon-launch.js";
import { getAgentDir } from "../config.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import type { SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";
import { TelegramApiError, TelegramClient } from "./client.js";
import { loadTelegramConfig, saveTelegramConfig, type TelegramConfig, telegramConfigPath } from "./config.js";
import type { TelegramMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 4000;

export function splitTelegramOutput(text: string): string[] {
	if (!text) return ["(Prime Agent returned no text.)"];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > MAX_MESSAGE_LENGTH) {
		let end = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
		if (end < MAX_MESSAGE_LENGTH / 2) end = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
		if (end < MAX_MESSAGE_LENGTH / 2) end = MAX_MESSAGE_LENGTH;
		// Do not split a UTF-16 surrogate pair.
		if (end > 0 && /[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
		chunks.push(remaining.slice(0, end));
		remaining = remaining.slice(end).replace(/^\s+/, "");
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

function sessionKey(message: TelegramMessage): string {
	return `${message.chat.id}${message.message_thread_id ? `:${message.message_thread_id}` : ""}`;
}

export function isTelegramMessageAllowed(config: TelegramConfig, message: TelegramMessage): boolean {
	if (config.allowAllUsers === true) return true;
	return message.from ? config.allowedUsers.includes(String(message.from.id)) : false;
}

export function isTelegramMessageAddressed(config: TelegramConfig, message: TelegramMessage, text: string): boolean {
	if (message.chat.type === "private") return true;
	if (!config.requireMention) return true;
	const username = config.botUsername;
	return !!username && text.toLowerCase().includes(`@${username.toLowerCase()}`);
}

function stripMention(config: TelegramConfig, text: string): string {
	if (!config.botUsername) return text;
	return text.replace(new RegExp(`@${config.botUsername}\\b`, "ig"), "").trim();
}

function responseData<T>(response: Awaited<ReturnType<DaemonClient["request"]>>): T {
	if (!response.success) throw new Error(response.error);
	return response.data as T;
}

export function assistantTextFromDaemonResponse(response: Awaited<ReturnType<DaemonClient["request"]>>): string {
	const data = responseData<unknown>(response);
	if (!data || typeof data !== "object" || !("text" in data))
		throw new Error("Daemon returned invalid assistant text");
	const text = (data as { text: unknown }).text;
	if (text === null) return "";
	if (typeof text !== "string") throw new Error("Daemon returned invalid assistant text");
	return text;
}

export class TelegramGateway {
	private readonly telegram: TelegramClient;
	private readonly daemon: DaemonClient;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly activeSessions = new Map<string, string>();
	private readonly abortController = new AbortController();

	constructor(
		private config: TelegramConfig,
		private readonly socketPath: string,
	) {
		this.telegram = new TelegramClient(config.botToken);
		this.daemon = new DaemonClient(socketPath);
	}

	async start(): Promise<void> {
		await ensureInteractiveDaemonRunning(this.socketPath, this.config.cwd);
		await this.daemon.connect(10_000);
		await this.daemon.waitForHello(10_000);
		this.daemon.enableAutoReconnect({
			recoverDaemon: async () => {
				await ensureInteractiveDaemonRunning(this.socketPath, this.config.cwd);
			},
			onStatus: (status) => {
				if (status.status !== "connected") console.error(chalk.yellow(`Prime Agent daemon: ${status.status}`));
			},
		});
		const me = await this.telegram.getMe(this.abortController.signal);
		if (me.username && this.config.botUsername !== me.username) {
			this.config = { ...this.config, botUsername: me.username };
			saveTelegramConfig(this.config);
		}
		console.log(chalk.green(`✓ Telegram connected as @${me.username ?? me.first_name}`));
		console.log(chalk.dim("  Press Ctrl+C to stop the gateway."));

		let offset: number | undefined;
		while (!this.abortController.signal.aborted) {
			try {
				const updates = await this.telegram.getUpdates({
					offset,
					timeout: 30,
					allowed_updates: ["message"],
					signal: this.abortController.signal,
				});
				for (const update of updates) {
					offset = Math.max(offset ?? 0, update.update_id + 1);
					if (update.message) void this.enqueue(update.message);
				}
			} catch (error) {
				if (this.abortController.signal.aborted) break;
				if (error instanceof TelegramApiError && error.errorCode === 409) throw error;
				console.error(
					chalk.yellow(
						`Telegram polling error: ${error instanceof Error ? error.message : String(error)}; retrying…`,
					),
				);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		}
		await Promise.allSettled(this.queues.values());
		this.daemon.close();
	}

	stop(): void {
		this.abortController.abort();
		for (const activeSessionId of this.activeSessions.values()) {
			void this.daemon.request({ type: "abort", activeSessionId }).catch(() => {});
		}
	}

	private enqueue(message: TelegramMessage): Promise<void> {
		const key = sessionKey(message);
		const command = (message.text ?? "").trim().split(/\s+/, 1)[0]?.split("@")[0]?.toLowerCase();
		if (command === "/stop" || command === "/status") {
			return this.handleMessage(message);
		}
		const previous = this.queues.get(key) ?? Promise.resolve();
		const next = previous
			.then(() => this.handleMessage(message))
			.catch((error) => {
				console.error(`Telegram message failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		this.queues.set(key, next);
		void next.finally(() => {
			if (this.queues.get(key) === next) this.queues.delete(key);
		});
		return next;
	}

	private async handleMessage(message: TelegramMessage): Promise<void> {
		let text = (message.text ?? message.caption ?? "").trim();
		if (
			!text ||
			!isTelegramMessageAllowed(this.config, message) ||
			!isTelegramMessageAddressed(this.config, message, text)
		)
			return;
		text = stripMention(this.config, text);
		const command = text.split(/\s+/, 1)[0]!.split("@")[0]!.toLowerCase();
		const options = {
			message_thread_id: message.message_thread_id,
			reply_parameters: { message_id: message.message_id },
		};

		if (command === "/help" || command === "/start") {
			await this.telegram.sendMessage(
				message.chat.id,
				"Prime Agent is ready. Send a message to start or continue this chat's persistent session.\n\n/new — start a new session\n/status — show session status\n/stop — stop the current turn\n/sethome — use this chat for notifications\n/whoami — show your Telegram ID",
				options,
			);
			return;
		}
		if (command === "/whoami") {
			await this.telegram.sendMessage(
				message.chat.id,
				`Your Telegram user ID is ${message.from?.id ?? "unknown"}.\nThis chat ID is ${message.chat.id}.`,
				options,
			);
			return;
		}
		if (command === "/sethome" || command === "/set-home") {
			this.config = { ...this.config, homeChannel: String(message.chat.id) };
			saveTelegramConfig(this.config);
			await this.telegram.sendMessage(
				message.chat.id,
				"✓ This chat is saved as the home channel for future notifications.",
				options,
			);
			return;
		}
		const key = sessionKey(message);
		if (command === "/new" || command === "/reset") {
			this.activeSessions.delete(key);
			if (this.config.sessions) delete this.config.sessions[key];
			saveTelegramConfig(this.config);
			await this.telegram.sendMessage(message.chat.id, "✨ Fresh session started.", options);
			return;
		}

		const activeSessionId = await this.getOrCreateSession(key);
		if (command === "/stop") {
			responseData(await this.daemon.request({ type: "abort", activeSessionId }));
			await this.telegram.sendMessage(message.chat.id, "Stopped.", options);
			return;
		}
		if (command === "/status") {
			const state = responseData<SessionSummary>(await this.daemon.request({ type: "get_state", activeSessionId }));
			await this.telegram.sendMessage(
				message.chat.id,
				`Prime Agent: ${state.isStreaming ? "working" : "idle"}\nMessages: ${state.messageCount}\nSession: ${state.sessionName ?? state.sessionId}`,
				options,
			);
			return;
		}

		const status = await this.telegram.sendMessage(message.chat.id, "Thinking…", options);
		const typing = setInterval(() => {
			void this.telegram.sendChatAction(message.chat.id, "typing", message.message_thread_id).catch(() => {});
		}, 4000);
		try {
			responseData(
				await this.daemon.request(
					{ type: "prompt_and_wait", activeSessionId, message: text, queueIfBusy: true },
					60 * 60 * 1000,
				),
			);
			const answer = assistantTextFromDaemonResponse(
				await this.daemon.request({ type: "get_last_assistant_text", activeSessionId }),
			);
			const chunks = splitTelegramOutput(answer);
			await this.telegram.editMessageText(chunks[0]!, {
				chat_id: message.chat.id,
				message_id: status.message_id,
				link_preview_options: { is_disabled: true },
			});
			for (const chunk of chunks.slice(1))
				await this.telegram.sendMessage(message.chat.id, chunk, {
					message_thread_id: message.message_thread_id,
					link_preview_options: { is_disabled: true },
				});
		} catch (error) {
			const safe =
				error instanceof Error ? error.message.replace(this.config.botToken, "<redacted>") : String(error);
			await this.telegram.editMessageText(`Prime Agent error: ${safe.slice(0, 3500)}`, {
				chat_id: message.chat.id,
				message_id: status.message_id,
			});
		} finally {
			clearInterval(typing);
		}
	}

	private async getOrCreateSession(key: string): Promise<string> {
		const activeSession = this.activeSessions.get(key);
		if (activeSession) return activeSession;
		const savedPath = this.config.sessions?.[key];
		const response = await this.daemon.request({
			type: "create",
			...(savedPath ? { sessionPath: savedPath } : {}),
			...(savedPath ? {} : { name: `telegram-${key.replace(/[^0-9A-Za-z_-]/g, "-")}-${Date.now().toString(36)}` }),
			config: { cwd: this.config.cwd ?? process.cwd(), agentDir: getAgentDir() },
		});
		const summary = responseData<SessionSummary>(response);
		if (!summary.activeSessionId) throw new Error("Daemon did not return an active session ID");
		if (summary.sessionFile && this.config.sessions?.[key] !== summary.sessionFile) {
			this.config = { ...this.config, sessions: { ...(this.config.sessions ?? {}), [key]: summary.sessionFile } };
			saveTelegramConfig(this.config);
		}
		this.activeSessions.set(key, summary.activeSessionId);
		return summary.activeSessionId;
	}
}

export async function runTelegramGateway(options: { daemonSocket?: string } = {}): Promise<void> {
	const config = loadTelegramConfig();
	if (!config)
		throw new Error(`Telegram is not configured. Run "prime-agent gateway setup" first (${telegramConfigPath()}).`);
	const gateway = new TelegramGateway(config, options.daemonSocket ?? defaultDaemonSocketPath());
	const stop = () => gateway.stop();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await gateway.start();
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

export async function printTelegramStatus(): Promise<void> {
	const config = loadTelegramConfig();
	if (!config) {
		console.log("Telegram: not configured");
		console.log('Run "prime-agent gateway setup".');
		return;
	}
	try {
		const me = await new TelegramClient(config.botToken).getMe(AbortSignal.timeout(10_000));
		console.log(`Telegram: configured and reachable${me.username ? ` (@${me.username})` : ""}`);
	} catch (error) {
		console.log(`Telegram: configured but unreachable (${error instanceof Error ? error.message : String(error)})`);
	}
	console.log(`Allowlist: ${config.allowAllUsers ? "open access" : `${config.allowedUsers.length} user(s)`}`);
	console.log(`Home channel: ${config.homeChannel ?? "not set"}`);
}
