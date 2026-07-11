import type { Message, MessageEntity, User } from "@grammyjs/types";
import { describe, expect, it } from "vitest";

import { checkAddressed, type BotIdentity } from "./addressing";

const BOT: BotIdentity = { id: 42, username: "MyBot" };

function user(id: number): User {
  return { id, is_bot: id === 42, first_name: id === 42 ? "MyBot" : "Someone" };
}

/** Build a minimal Message; only the fields addressing reads are required. */
function msg(partial: Partial<Message>): Message {
  return { message_id: 1, date: 0, chat: { id: 1, type: "group" }, ...partial } as Message;
}

/** A `text` message carrying a single entity. */
function withEntity(text: string, entity: MessageEntity): Message {
  return msg({ text, entities: [entity] });
}

/** A minimal `reply_to_message` authored by the given user. */
function replyFrom(id: number): Message["reply_to_message"] {
  return { from: user(id) } as unknown as Message["reply_to_message"];
}

describe("checkAddressed", () => {
  it("addresses every private message", () => {
    expect(checkAddressed(msg({ text: "hello" }), "private", BOT)).toEqual({
      addressed: true,
      source: "private",
    });
  });

  it("ignores plain group chatter", () => {
    expect(checkAddressed(msg({ text: "just talking" }), "group", BOT).addressed).toBe(false);
  });

  it("addresses a reply to one of the bot's messages", () => {
    const m = msg({ text: "and you?", reply_to_message: replyFrom(42) });
    expect(checkAddressed(m, "supergroup", BOT)).toEqual({ addressed: true, source: "reply" });
  });

  it("does not address a reply to someone else", () => {
    const m = msg({ text: "and you?", reply_to_message: replyFrom(99) });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("addresses an @username mention entity (case-insensitive)", () => {
    const m = withEntity("hey @mybot help", { type: "mention", offset: 4, length: 6 });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "mention" });
  });

  it("addresses a text_mention entity for the bot id", () => {
    const m = withEntity("hey there help", {
      type: "text_mention",
      offset: 4,
      length: 5,
      user: user(42),
    });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "mention" });
  });

  it("does not address an @mention of a different user", () => {
    const m = withEntity("hey @someoneelse", { type: "mention", offset: 4, length: 12 });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("addresses a /command@botusername targeting the bot", () => {
    const m = withEntity("/start@mybot", { type: "bot_command", offset: 0, length: 12 });
    expect(checkAddressed(m, "group", BOT)).toEqual({ addressed: true, source: "command" });
  });

  it("does not address a bare /command with no bot suffix in a group", () => {
    const m = withEntity("/start", { type: "bot_command", offset: 0, length: 6 });
    expect(checkAddressed(m, "group", BOT).addressed).toBe(false);
  });

  it("ignores channels and other chat types", () => {
    expect(checkAddressed(msg({ text: "@mybot" }), "channel", BOT).addressed).toBe(false);
  });
});
