import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { getAgentDir } from "../config.js";
import { isValidTelegramBotToken, loadTelegramConfig, saveTelegramConfig, telegramConfigPath } from "./config.js";

async function ask(question: string, defaultValue = ""): Promise<string> {
	const rl = createInterface({ input, output });
	try {
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		return (await rl.question(`${question}${suffix}: `)).trim() || defaultValue;
	} finally {
		rl.close();
	}
}

async function askSecret(question: string): Promise<string> {
	if (!input.isTTY || typeof input.setRawMode !== "function") return ask(question);
	output.write(`${question}: `);
	return new Promise<string>((resolve, reject) => {
		let value = "";
		const wasRaw = input.isRaw;
		const finish = (error?: Error) => {
			input.off("data", onData);
			input.setRawMode(wasRaw ?? false);
			output.write("\n");
			error ? reject(error) : resolve(value.trim());
		};
		const onData = (chunk: Buffer) => {
			for (const byte of chunk) {
				if (byte === 3) return finish(new Error("Telegram setup cancelled."));
				if (byte === 10 || byte === 13) return finish();
				if (byte === 8 || byte === 127) {
					if (value) {
						value = value.slice(0, -1);
						output.write("\b \b");
					}
				} else if (byte >= 32 && byte <= 126) {
					value += String.fromCharCode(byte);
					output.write("*");
				}
			}
		};
		input.setRawMode(true);
		input.resume();
		input.on("data", onData);
	});
}

async function confirm(question: string, defaultValue: boolean): Promise<boolean> {
	const hint = defaultValue ? "Y/n" : "y/N";
	const answer = (await ask(`${question} [${hint}]`)).toLowerCase();
	return answer ? answer === "y" || answer === "yes" : defaultValue;
}

export async function verifyTelegramToken(token: string): Promise<{ username?: string }> {
	const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
	const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
	if (!response.ok || !body.ok) throw new Error(body.description || `Telegram returned HTTP ${response.status}`);
	return { username: body.result?.username };
}

export async function runTelegramSetup(): Promise<void> {
	if (!input.isTTY) throw new Error("Telegram setup needs an interactive terminal.");
	console.log(chalk.bold("\nTelegram\n"));
	const current = loadTelegramConfig();
	if (current) {
		console.log(chalk.cyan("Telegram: already configured"));
		if (!(await confirm("Reconfigure Telegram?", false))) return;
	}

	console.log("Create a bot via @BotFather on Telegram:");
	console.log("  1. Open https://t.me/BotFather");
	console.log("  2. Send /newbot and follow the prompts");
	console.log("  3. Paste the complete bot token here\n");

	let token = "";
	while (!token) {
		token = await askSecret("Telegram bot token");
		if (!token) return;
		if (!isValidTelegramBotToken(token)) {
			console.error(chalk.red("Invalid token format. Expected <numeric_id>:<alphanumeric_hash>."));
			token = "";
			continue;
		}
		try {
			const me = await verifyTelegramToken(token);
			console.log(chalk.green(`✓ Connected${me.username ? ` as @${me.username}` : ""}`));
		} catch (error) {
			console.error(
				chalk.red(`Could not verify that token: ${error instanceof Error ? error.message : String(error)}`),
			);
			if (!(await confirm("Save it anyway?", false))) token = "";
		}
	}

	console.log("\n🔒 Security: Restrict who can use your bot");
	console.log("   Message @userinfobot to find your numeric Telegram user ID.");
	let allowed: string[] = [];
	let allowAllUsers = false;
	while (allowed.length === 0 && !allowAllUsers) {
		allowed = (await ask("Allowed user IDs (comma-separated)"))
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		if (allowed.some((id) => !/^\d+$/.test(id))) {
			console.error(chalk.red("User IDs must be numeric. Use @userinfobot to find yours."));
			allowed = [];
			continue;
		}
		if (allowed.length === 0) {
			console.log(chalk.yellow("⚠ Open access lets anyone who finds the bot use Prime Agent and its tools."));
			allowAllUsers = await confirm("Explicitly allow every Telegram user?", false);
		}
	}
	if (allowAllUsers) console.log(chalk.yellow("⚠ Telegram is configured for open access."));
	else console.log(chalk.green("✓ Telegram allowlist configured"));

	console.log("\n📬 Home Channel: saved as the default destination for future notifications.");
	let homeChannel: string | undefined;
	if (allowed[0] && (await confirm(`Use your user ID (${allowed[0]}) as the home channel?`, true)))
		homeChannel = allowed[0];
	else homeChannel = (await ask("Home channel ID (leave empty to set later with /set-home)")) || undefined;

	let username: string | undefined;
	try {
		username = (await verifyTelegramToken(token)).username;
	} catch {
		/* already handled */
	}
	saveTelegramConfig({
		botToken: token,
		allowedUsers: allowed,
		allowAllUsers,
		homeChannel,
		cwd: process.cwd(),
		requireMention: true,
		botUsername: username,
		sessions: current?.sessions ?? {},
	});
	console.log(chalk.green("\n✓ Telegram configured"));
	console.log(`  Configuration: ${telegramConfigPath(getAgentDir())}`);
	console.log("  Start it with: prime-agent gateway");
}
