/** A chat identifier accepted by the Telegram Bot API. */
export type ChatId = number | string;

export type ParseMode = "MarkdownV2" | "HTML" | "Markdown";

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: boolean;
	added_to_attachment_menu?: boolean;
	can_join_groups?: boolean;
	can_read_all_group_messages?: boolean;
	supports_inline_queries?: boolean;
	can_connect_to_business?: boolean;
	has_main_web_app?: boolean;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface MessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: TelegramUser;
	language?: string;
	custom_emoji_id?: string;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	sender_chat?: TelegramChat;
	date: number;
	chat: TelegramChat;
	text?: string;
	entities?: MessageEntity[];
	caption?: string;
	[key: string]: unknown;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	channel_post?: TelegramMessage;
	edited_channel_post?: TelegramMessage;
	callback_query?: {
		id: string;
		from: TelegramUser;
		data?: string;
		message?: TelegramMessage;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface ResponseParameters {
	migrate_to_chat_id?: number;
	retry_after?: number;
}

export interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: ResponseParameters;
}

export type ChatAction =
	| "typing"
	| "upload_photo"
	| "record_video"
	| "upload_video"
	| "record_voice"
	| "upload_voice"
	| "upload_document"
	| "choose_sticker"
	| "find_location"
	| "record_video_note"
	| "upload_video_note";

export interface GetUpdatesOptions {
	offset?: number;
	limit?: number;
	timeout?: number;
	allowed_updates?: string[];
	signal?: AbortSignal;
}

export interface SendMessageOptions {
	message_thread_id?: number;
	parse_mode?: ParseMode;
	disable_notification?: boolean;
	protect_content?: boolean;
	reply_parameters?: { message_id: number; chat_id?: ChatId; allow_sending_without_reply?: boolean };
	reply_markup?: unknown;
	link_preview_options?: {
		is_disabled?: boolean;
		url?: string;
		prefer_small_media?: boolean;
		prefer_large_media?: boolean;
		show_above_text?: boolean;
	};
}

export interface EditMessageTextOptions {
	chat_id?: ChatId;
	message_id?: number;
	inline_message_id?: string;
	parse_mode?: ParseMode;
	reply_markup?: unknown;
	link_preview_options?: SendMessageOptions["link_preview_options"];
}

export interface TelegramClientOptions {
	/** Alternate fetch implementation, primarily useful for tests. */
	fetch?: typeof globalThis.fetch;
	/** API root. Defaults to https://api.telegram.org. */
	baseUrl?: string;
}
