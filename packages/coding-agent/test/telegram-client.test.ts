import { describe, expect, it, vi } from "vitest";
import { TelegramApiError, TelegramBotApi, TelegramClient } from "../src/telegram/client.js";
import { chunkPlainTextForMarkdownV2, escapeMarkdownV2, splitTelegramMessage } from "../src/telegram/text.js";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("TelegramClient", () => {
	it("calls getMe and returns the API result", async () => {
		const fetch = vi.fn(async () => jsonResponse({ ok: true, result: { id: 7, is_bot: true, first_name: "Prime" } }));
		const client = new TelegramBotApi("secret", { fetch: fetch as typeof globalThis.fetch });
		await expect(client.getMe()).resolves.toMatchObject({ id: 7, first_name: "Prime" });
		expect(fetch).toHaveBeenCalledWith(
			"https://api.telegram.org/botsecret/getMe",
			expect.objectContaining({ method: "POST", body: "{}" }),
		);
	});

	it("passes long-polling parameters and the abort signal to getUpdates", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true, result: [] }));
		const client = new TelegramClient("t", {
			fetch,
			baseUrl: "https://telegram.test/",
		});
		const controller = new AbortController();
		await client.getUpdates({
			offset: 12,
			limit: 25,
			timeout: 45,
			allowed_updates: ["message"],
			signal: controller.signal,
		});
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://telegram.test/bott/getUpdates");
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			offset: 12,
			limit: 25,
			timeout: 45,
			allowed_updates: ["message"],
		});
		expect((init as RequestInit).signal).toBe(controller.signal);
	});

	it("advances the offset while polling", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: true, result: [{ update_id: 4 }, { update_id: 8 }] }))
			.mockResolvedValueOnce(jsonResponse({ ok: true, result: [{ update_id: 9 }] }));
		const client = new TelegramClient("t", { fetch: fetch as typeof globalThis.fetch });
		const poller = client.pollUpdates({ timeout: 10 });
		await poller.next();
		await poller.next();
		await poller.return();
		expect(JSON.parse(fetch.mock.calls[1][1].body as string)).toMatchObject({ offset: 9, timeout: 10 });
	});

	it("sends, edits, and reports chat actions", async () => {
		const message = { message_id: 1, date: 0, chat: { id: 2, type: "private" } };
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: true, result: message }))
			.mockResolvedValueOnce(jsonResponse({ ok: true, result: message }))
			.mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
		const client = new TelegramClient("t", { fetch: fetch as typeof globalThis.fetch });
		await client.sendMessage(2, "hello", { parse_mode: "MarkdownV2" });
		await client.editMessageText("updated", { chat_id: 2, message_id: 1 });
		await client.sendChatAction(2, "typing", 5);
		expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
			chat_id: 2,
			text: "hello",
			parse_mode: "MarkdownV2",
		});
		expect(JSON.parse(fetch.mock.calls[1][1].body as string)).toEqual({ text: "updated", chat_id: 2, message_id: 1 });
		expect(JSON.parse(fetch.mock.calls[2][1].body as string)).toEqual({
			chat_id: 2,
			action: "typing",
			message_thread_id: 5,
		});
	});

	it("turns Telegram failures into a typed error", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse(
				{ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
				429,
			),
		);
		const client = new TelegramClient("t", { fetch: fetch as typeof globalThis.fetch });
		const error = await client.getMe().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TelegramApiError);
		expect(error).toMatchObject({ method: "getMe", errorCode: 429, parameters: { retry_after: 3 } });
	});
});

describe("Telegram MarkdownV2 plain-text handling", () => {
	it("escapes every MarkdownV2 metacharacter", () => {
		expect(escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\")).toBe(
			"\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
		);
	});

	it("chunks on whitespace without losing input or splitting escapes", () => {
		const chunks = chunkPlainTextForMarkdownV2("hello world. [again]", 12);
		expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
		expect(chunks.every((chunk) => !/(^|[^\\])\\$/.test(chunk))).toBe(true);
		expect(chunks.join("")).toBe(escapeMarkdownV2("hello world. [again]"));
	});

	it("does not split surrogate pairs and rejects an impossibly small bound", () => {
		expect(chunkPlainTextForMarkdownV2("😀😀", 2)).toEqual(["😀", "😀"]);
		expect(() => chunkPlainTextForMarkdownV2(".", 1)).toThrow(RangeError);
		expect(chunkPlainTextForMarkdownV2("")).toEqual([]);
		expect(splitTelegramMessage("a.b", 3)).toEqual(["a\\.", "b"]);
	});
});
