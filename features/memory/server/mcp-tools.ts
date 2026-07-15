import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { resolveChatUserByReference } from "@/features/known-users/server/service";
import { getToolContext } from "@/server/mcp/context";

import { MAX_FACT_LENGTH, MIN_FACT_LENGTH } from "../prompt";
import type { MemoryMatch } from "../types";
import { readMemory, saveMemoryNote, searchMemory } from "./service";

/**
 * The memory MCP tools. Each is self-describing and names no other tool
 * (`tools-self-describe-atomic`): the model chooses between them from their
 * descriptions alone.
 *
 * The current chat and speaker come from the per-turn tool context, never from
 * the model — a tool cannot be talked into writing memory into another
 * conversation. The person a `user` fact is *about* defaults to whoever the bot
 * is talking to (the bound speaker) and is otherwise named by a name the model
 * already sees — never a numeric id, which the model is never given. That
 * reference is resolved to a real participant of the current chat here, so a tool
 * can only ever touch someone who has actually messaged in this conversation.
 */

/**
 * Resolve the person a `user`-scope memory operation is about to a numeric known-user
 * id. With no `person` reference it binds the current speaker (the only subject in a
 * DM, and the common case in a group); with one, it resolves that name/@username
 * against this chat's participants. Returns a model-facing error otherwise.
 */
async function resolveSubjectId(
  person: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const { chatId, userId: speakerId } = getToolContext();
  const reference = person?.trim();
  if (!reference) {
    if (!speakerId) {
      return { ok: false, error: "No one is identified to save this about — name the person." };
    }
    return { ok: true, userId: speakerId };
  }
  const resolved = await resolveChatUserByReference(chatId, reference);
  if (resolved.status === "not_found") {
    return {
      ok: false,
      error: `No one in this chat is known as "${reference}". You can only remember facts about people who have messaged here.`,
    };
  }
  if (resolved.status === "ambiguous") {
    return {
      ok: false,
      error: `"${reference}" matches ${resolved.count} people here — be more specific (e.g. use their @username).`,
    };
  }
  return { ok: true, userId: resolved.user.userId };
}

export const MEMORY_SAVE_TOOL = "memory_save";
export const MEMORY_GET_TOOL = "memory_get";
export const MEMORY_SEARCH_TOOL = "memory_search";

export const MEMORY_TOOL_NAMES = [MEMORY_SAVE_TOOL, MEMORY_GET_TOOL, MEMORY_SEARCH_TOOL];

const SEARCH_LIMIT_DEFAULT = 8;
const SEARCH_LIMIT_MAX = 20;

const memoryScope = z.enum(["user", "general"]);

const memoryOutputSchema = {
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  memories: z.array(
    z.object({
      scope: z.string(),
      user_id: z.string().nullable(),
      content: z.string(),
    }),
  ),
};

/** Render matches as the model-facing text + structured result. */
function buildResult(matches: MemoryMatch[], emptyText: string) {
  const text =
    matches.length === 0
      ? emptyText
      : matches
          .map((m) => `[${m.scope === "user" ? `user ${m.userId}` : "general"}] ${m.content}`)
          .join("\n");
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: {
      ok: true,
      count: matches.length,
      memories: matches.map((m) => ({
        scope: m.scope,
        user_id: m.userId,
        content: m.content,
      })),
    },
  };
}

/** Register the memory MCP tools on the shared server. */
export function registerMemoryMcpTools(server: McpServer): void {
  server.registerTool(
    MEMORY_SAVE_TOOL,
    {
      title: "Save a durable fact to long-term memory",
      description:
        "Record ONE durable fact so you still know it in future conversations, days or months " +
        "from now. This is the ONLY way anything is remembered: your reply is forgotten once the " +
        "conversation moves on, so a fact you do not save here is lost permanently, and saying " +
        "'I'll remember that' without calling this tool is a false promise.\n" +
        "MUST call, before you reply, whenever the message asks you to remember, note, save, keep " +
        "in mind, or not forget something.\n" +
        "ALSO call, without being asked, the moment someone reveals something lastingly true about " +
        "themselves or another person — their name or what they want to be called, where they " +
        "live or are from, their job or studies, their family and pets, a stable preference or " +
        "taste, a skill, a health constraint, a boundary, a recurring plan, or a standing " +
        "instruction about how they want you to behave. Saving proactively is expected of you, " +
        "not optional: prefer saving a fact that turns out to be minor over losing one that " +
        "mattered.\n" +
        "Use scope 'user' for a fact about a specific person (this is how you remember someone " +
        "across chats). By default the fact is saved about the person you are talking to right " +
        "now; to save it about someone else in this chat, name them in 'person' by a name you " +
        "already see for them (their first name, @username, or a known nickname) — never a numeric " +
        "id. Use scope 'general' for knowledge that is not about any one person — a definition, a " +
        "rule, a convention, how something works.\n" +
        "Do NOT save: guesses or inferences from vibes, passing moods, jokes, insults, one-off " +
        "plans, or ordinary chit-chat. Do not re-save something you have already saved.\n" +
        "Save ONE fact per call — make several calls for several facts — and write each as a " +
        "single self-contained sentence that will still make sense to someone reading it months " +
        "later with no memory of this conversation (include the who and the what, not 'he said " +
        "yes').",
      inputSchema: {
        scope: memoryScope.describe(
          "'user' for a fact about a specific person, 'general' for shared knowledge",
        ),
        person: z
          .string()
          .optional()
          .describe(
            "Who the fact is about, named by a name you already see for them (first name, @username, " +
              "or known nickname). Omit to save it about the person you are talking to now. Ignored for scope 'general'.",
          ),
        content: z
          .string()
          .min(MIN_FACT_LENGTH)
          .max(MAX_FACT_LENGTH)
          .describe("The durable fact, as one self-contained sentence"),
      },
      outputSchema: {
        ok: z.boolean(),
        scope: z.string(),
        user_id: z.string().nullable(),
        saved: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scope, person, content }) => {
      const { chatId } = getToolContext();

      let subjectId: string | null = null;
      if (scope === "user") {
        const subject = await resolveSubjectId(person);
        if (!subject.ok) {
          return { content: [{ type: "text" as const, text: subject.error }], isError: true };
        }
        subjectId = subject.userId;
      }

      const outcome = await saveMemoryNote({ scope, userId: subjectId, content, chatId });
      if (!outcome.ok) {
        return {
          content: [{ type: "text" as const, text: outcome.error }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Saved to long-term memory${subjectId ? ` about user ${subjectId}` : ""}. ` +
              "It is merged into your durable memory overnight and will be there in future " +
              "conversations. Do not save this same fact again.",
          },
        ],
        structuredContent: {
          ok: true,
          scope,
          user_id: outcome.entry.userId,
          saved: true,
        },
      };
    },
  );

  server.registerTool(
    MEMORY_GET_TOOL,
    {
      title: "Read everything stored in one memory scope",
      description:
        "Read out a whole memory scope. With scope 'user', returns every durable fact you know " +
        "about a person — by default the person you are talking to now, or someone else in this " +
        "chat when you name them in 'person' (by a name you already see for them, never a numeric " +
        "id); with scope 'general', returns all the shared knowledge you have stored (definitions, " +
        "rules, conventions). Use it when you need the full picture rather than a specific answer — " +
        "for example before saying you do not know something durable about someone, or to review " +
        "what shared knowledge exists.",
      inputSchema: {
        scope: memoryScope.describe("Which memory to read out"),
        person: z
          .string()
          .optional()
          .describe(
            "Whose memory to read, named by a name you already see for them (first name, @username, " +
              "or known nickname). Omit to read the person you are talking to now. Ignored for scope 'general'.",
          ),
      },
      outputSchema: memoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ scope, person }) => {
      let subjectId: string | null = null;
      if (scope === "user") {
        const subject = await resolveSubjectId(person);
        if (!subject.ok) {
          return { content: [{ type: "text" as const, text: subject.error }], isError: true };
        }
        subjectId = subject.userId;
      }
      const matches = await readMemory({ scope, userId: subjectId });
      return buildResult(
        matches,
        scope === "user"
          ? "(nothing durable is stored about this person yet)"
          : "(no general knowledge is stored yet)",
      );
    },
  );

  server.registerTool(
    MEMORY_SEARCH_TOOL,
    {
      title: "Search long-term memory",
      description:
        "Search everything you durably know — both facts about people and shared general " +
        "knowledge — by meaning as well as wording, so it finds a fact even when the question " +
        "phrases it differently than it was stored. Use it to recall something durable when you " +
        "do not know which person or scope it belongs to, or to check what you already know " +
        "before answering a question about a lasting fact. Each result is tagged with the scope " +
        "and person it belongs to. Note this searches durable memory — what you know about " +
        "people and the world — not what was said in a past conversation.",
      inputSchema: {
        query: z
          .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
          .describe(
            "What to recall — a topic, name, preference, or fact. Pass several phrasings as an " +
              "array to search them all at once.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .default(SEARCH_LIMIT_DEFAULT)
          .describe(`Max matches to return per query (max ${SEARCH_LIMIT_MAX})`),
      },
      outputSchema: memoryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const queries = Array.isArray(query) ? query : [query];
      const matches = await searchMemory({
        queries,
        limit: limit ?? SEARCH_LIMIT_DEFAULT,
      });
      return buildResult(matches, "(no matching memory — this may simply never have been saved)");
    },
  );
}
