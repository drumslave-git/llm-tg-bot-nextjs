/**
 * Pure facts about Telegram identifiers, single-sourced so the assumption is
 * written down once. Client-safe (no server dependencies).
 */

/**
 * Whether a chat id names a group/supergroup rather than a private chat.
 * Telegram encodes the kind in the sign: a private chat's id is the (positive)
 * user id, a group's is negative. If Telegram ever changes this, this is the
 * one place that knows.
 */
export function isGroupChatId(chatId: string): boolean {
  return chatId.startsWith("-");
}
