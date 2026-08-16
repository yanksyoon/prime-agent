import type {
	ChatAction,
	ChatId,
	EditMessageTextOptions,
	GetUpdatesOptions,
	SendMessageOptions,
	TelegramApiResponse,
	TelegramClientOptions,
	TelegramMessage,
	TelegramUpdate,
	TelegramUser,
} from "./types.js";

export class TelegramApiError extends Error {
	readonly method: string;
	readonly errorCode?: number;
	readonly parameters?: TelegramApiResponse<never>["parameters"];

	constructor(method: string, response: TelegramApiResponse<never>) {
		super(response.description ?? `Telegram API method ${method} failed`);
		this.name = "TelegramApiError";
		this.method = method;
		this.errorCode = response.error_code;
		this.parameters = response.parameters;
	}
}

/** A small, dependency-free client for the Telegram Bot HTTP API. */
export class TelegramBotApi {
	readonly token: string;
	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly apiUrl: string;

	constructor(token: string, options: TelegramClientOptions = {}) {
		if (!token) throw new TypeError("A Telegram bot token is required");
		this.token = token;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		if (!this.fetchImpl) throw new TypeError("This runtime does not provide fetch");
		const root = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
		this.apiUrl = `${root}/bot${token}`;
	}

	private async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
		const response = await this.fetchImpl(`${this.apiUrl}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});

		let payload: TelegramApiResponse<T>;
		try {
			payload = (await response.json()) as TelegramApiResponse<T>;
		} catch (cause) {
			throw new Error(`Telegram API method ${method} returned an invalid JSON response (HTTP ${response.status})`, {
				cause,
			});
		}
		if (!response.ok || !payload.ok || !("result" in payload)) {
			throw new TelegramApiError(method, payload as TelegramApiResponse<never>);
		}
		return payload.result as T;
	}

	getMe(signal?: AbortSignal): Promise<TelegramUser> {
		return this.call<TelegramUser>("getMe", {}, signal);
	}

	getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
		const { signal, ...parameters } = options;
		return this.call<TelegramUpdate[]>("getUpdates", parameters, signal);
	}

	/**
	 * Continuously long-poll updates, advancing the offset after every batch.
	 * Abort the supplied signal to stop iteration (the abort error is propagated).
	 */
	async *pollUpdates(options: GetUpdatesOptions = {}): AsyncGenerator<TelegramUpdate[], void, void> {
		let offset = options.offset;
		for (;;) {
			const updates = await this.getUpdates({ timeout: 30, ...options, offset });
			if (updates.length > 0) {
				offset = Math.max(...updates.map((update) => update.update_id)) + 1;
				yield updates;
			}
		}
	}

	sendMessage(chatId: ChatId, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("sendMessage", { chat_id: chatId, text, ...options });
	}

	editMessageText(text: string, options: EditMessageTextOptions): Promise<TelegramMessage | true>;
	editMessageText(
		chatId: ChatId,
		messageId: number,
		text: string,
		options?: Omit<EditMessageTextOptions, "chat_id" | "message_id" | "inline_message_id">,
	): Promise<TelegramMessage | true>;
	editMessageText(
		textOrChatId: string | number,
		optionsOrMessageId: EditMessageTextOptions | number,
		text?: string,
		options: Omit<EditMessageTextOptions, "chat_id" | "message_id" | "inline_message_id"> = {},
	): Promise<TelegramMessage | true> {
		const usingChatArguments = typeof optionsOrMessageId === "number";
		const messageText = usingChatArguments ? text : textOrChatId;
		const parameters: EditMessageTextOptions = usingChatArguments
			? { chat_id: textOrChatId, message_id: optionsOrMessageId, ...options }
			: optionsOrMessageId;
		const hasInlineId = typeof parameters.inline_message_id === "string";
		const hasChatMessageId = parameters.chat_id !== undefined && parameters.message_id !== undefined;
		if (typeof messageText !== "string" || (!hasInlineId && !hasChatMessageId)) {
			throw new TypeError("editMessageText requires inline_message_id or both chat_id and message_id");
		}
		return this.call<TelegramMessage | true>("editMessageText", { text: messageText, ...parameters });
	}

	sendChatAction(chatId: ChatId, action: ChatAction, messageThreadId?: number): Promise<true> {
		return this.call<true>("sendChatAction", {
			chat_id: chatId,
			action,
			...(messageThreadId === undefined ? {} : { message_thread_id: messageThreadId }),
		});
	}
}

/** Backwards-compatible descriptive alias. */
export { TelegramBotApi as TelegramClient };
