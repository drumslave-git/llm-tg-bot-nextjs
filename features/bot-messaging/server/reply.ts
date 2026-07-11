/**
 * Reply formatting for Telegram delivery.
 *
 * v1 sends replies as plain text (no `parse_mode`) — correct and safe for any
 * model output. Rich markdown/HTML rendering is a later enhancement. The only
 * hard rule here is Telegram's 4096-character per-message limit.
 */

/** Telegram's maximum message length, in UTF-16 code units. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const ELLIPSIS = "\n…";

/** Trim and truncate reply text to Telegram's length limit. */
export function formatReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return trimmed;
  return trimmed.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - ELLIPSIS.length) + ELLIPSIS;
}
