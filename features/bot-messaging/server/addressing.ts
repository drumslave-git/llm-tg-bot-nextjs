import type { Message } from "@grammyjs/types";

/**
 * Whether a message is addressed to the bot. Pure and deterministic — no network
 * calls — so it is fully unit-testable and cheap to run on every update.
 *
 * Rules (recreated from the MVP's deterministic checks):
 * - Private chats: always addressed.
 * - Groups/supergroups: addressed when the message @mentions the bot (by
 *   username or a `text_mention` entity), replies to one of the bot's messages,
 *   or is a `/command@botusername` targeting the bot.
 *
 * The MVP additionally runs an LLM "analyzer" for name/other-language references
 * in groups; that is deferred (it costs an LLM call per group message) and can
 * be layered on later without changing this contract.
 */

export type AddressSource = "private" | "mention" | "reply" | "command";

export interface AddressResult {
  addressed: boolean;
  source?: AddressSource;
}

/** Minimal identity the addressing check needs. */
export interface BotIdentity {
  id: number;
  username: string;
}

const NOT_ADDRESSED: AddressResult = { addressed: false };

/** Telegram entity offsets are UTF-16 code units, matching JS string indexing. */
function sliceEntity(text: string, offset: number, length: number): string {
  return text.slice(offset, offset + length);
}

function isReplyToBot(message: Message, botId: number): boolean {
  return message.reply_to_message?.from?.id === botId;
}

function hasUsernameMention(message: Message, botId: number, username: string): boolean {
  const text = message.text ?? message.caption ?? "";
  if (!text) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user.id === botId) return true;
    if (entity.type === "mention") {
      const mention = sliceEntity(text, entity.offset, entity.length).replace(/^@/, "").toLowerCase();
      if (mention === user) return true;
    }
  }
  // Fallback for clients that omit entities: literal "@username" substring.
  return user.length > 0 && text.toLowerCase().includes(`@${user}`);
}

function hasCommandForBot(message: Message, username: string): boolean {
  const text = message.text ?? message.caption ?? "";
  if (!text.trimStart().startsWith("/")) return false;

  const user = username.toLowerCase();
  const entities = [...(message.entities ?? []), ...(message.caption_entities ?? [])];
  for (const entity of entities) {
    if (entity.type !== "bot_command") continue;
    const cmd = sliceEntity(text, entity.offset, entity.length);
    const at = cmd.indexOf("@");
    if (at !== -1 && cmd.slice(at + 1).toLowerCase() === user) return true;
  }
  return false;
}

/** Decide whether the bot should treat this message as addressed to it. */
export function checkAddressed(
  message: Message,
  chatType: string,
  bot: BotIdentity,
): AddressResult {
  if (chatType === "private") return { addressed: true, source: "private" };
  if (chatType !== "group" && chatType !== "supergroup") return NOT_ADDRESSED;
  if (!bot.id || !bot.username) return NOT_ADDRESSED;

  if (isReplyToBot(message, bot.id)) return { addressed: true, source: "reply" };
  // Command before the mention fallback: `/start@botname` carries a bot_command
  // entity, and its `@botname` suffix would otherwise match the loose mention check.
  if (hasCommandForBot(message, bot.username)) return { addressed: true, source: "command" };
  if (hasUsernameMention(message, bot.id, bot.username)) return { addressed: true, source: "mention" };
  return NOT_ADDRESSED;
}
