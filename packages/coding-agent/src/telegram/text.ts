const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
const MARKDOWN_V2_SPECIAL_CHAR = new Set("_*[]()~`>#+-=|{}.!\\");

/** Escape arbitrary plain text so Telegram renders it literally in MarkdownV2 mode. */
export function escapeMarkdownV2(text: string): string {
	return text.replace(MARKDOWN_V2_SPECIAL, "\\$&");
}

/**
 * Escape plain text for MarkdownV2 and split it into bounded messages.
 *
 * Escapes are treated atomically, so a chunk can never end with the first
 * backslash of an escape. Whitespace is preferred as a split point and all
 * input (including that whitespace) is preserved across the chunks.
 */
export function chunkPlainTextForMarkdownV2(text: string, maxLength = 4096): string[] {
	if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
		throw new RangeError("maxLength must be a positive safe integer");
	}
	if (text.length === 0) return [];

	const units = Array.from(text, (character) => {
		const escaped = MARKDOWN_V2_SPECIAL_CHAR.has(character) ? `\\${character}` : character;
		return { escaped, isWhitespace: /\s/u.test(character) };
	});
	const chunks: string[] = [];
	let start = 0;

	while (start < units.length) {
		let end = start;
		let length = 0;
		let lastWhitespaceEnd = -1;
		while (end < units.length && length + units[end].escaped.length <= maxLength) {
			length += units[end].escaped.length;
			if (units[end].isWhitespace) lastWhitespaceEnd = end + 1;
			end++;
		}
		if (end === start) {
			throw new RangeError(`maxLength ${maxLength} is too small for a single escaped character`);
		}
		if (end < units.length && lastWhitespaceEnd > start) end = lastWhitespaceEnd;
		chunks.push(
			units
				.slice(start, end)
				.map((unit) => unit.escaped)
				.join(""),
		);
		start = end;
	}
	return chunks;
}

/** Short alias for callers that already selected MarkdownV2 parse mode. */
export const chunkPlainText = chunkPlainTextForMarkdownV2;

/** Split and MarkdownV2-escape a plain-text Telegram message. */
export const splitTelegramMessage = chunkPlainTextForMarkdownV2;
