import "server-only";

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { ApiError } from "@/lib/api-error";
import type { McpToolCallResult } from "@/server/mcp/tool-result";
import {
  CHAT_COMPLETION_TIMEOUT_MS,
  createOpenAiClient,
  servedModelOf,
  toLlmError,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatUsage,
  type LlmConnection,
} from "./client";

/**
 * Chat completion with tools as ONE conversation. Each round the model either
 * answers — that response is the reply — or emits tool calls, whose results are
 * appended and the same conversation re-sent. There is no separate tool-selection
 * pass: every request carries the same system prompt, so a turn that needs no
 * tools costs a single inference and keeps the provider's prompt-cache prefix.
 *
 * Termination is progress-driven (ported from the MVP): a round with no tool
 * calls ends the loop; a streak of {@link MAX_STALL_ROUNDS} rounds that each
 * introduce no new call (a stuck or looping model) takes the tools away for one
 * final forced answer, and the result is flagged `loopDetected`.
 */

/** A single executed tool call, surfaced to the caller for trace recording. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: McpToolCallResult;
  ok: boolean;
}

/** One model round, as produced by the injected completion function. */
export interface ToolLoopRound {
  /** The assistant message (with `tool_calls` and/or content) to append verbatim. */
  assistantMessage: ChatCompletionMessageParam;
  toolCalls: ChatCompletionMessageToolCall[];
  content: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Raw provider response for this round (recorded as the final response body). */
  raw: unknown;
}

/** Runs one model round over the current conversation. */
export type CompleteRound = (
  conversation: ChatCompletionMessageParam[],
) => Promise<ToolLoopRound>;

export interface RunToolLoopParams {
  seed: ChatCompletionMessageParam[];
  complete: CompleteRound;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
  onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
  /** Hard cap on model rounds; unset = unbounded (progress guard still applies). */
  maxRounds?: number;
}

export interface ToolLoopResult {
  content: string;
  usage: ChatUsage;
  /** Summed latency across every model round. */
  latencyMs: number;
  rounds: number;
  /** Raw provider response of the final round. */
  responseBody: unknown;
  /** True when the loop was stopped by the stall guard rather than a real answer. */
  loopDetected: boolean;
}

/**
 * A streak of this many rounds that each introduce no tool call we have not
 * already run means the model has stalled. A single repeated call is not a stall
 * (iterating over items legitimately re-runs the same call), so only a run of
 * no-new-action rounds stops the loop. The streak resets on any new call.
 */
const MAX_STALL_ROUNDS = 3;

function toolCallSignature(call: ChatCompletionMessageToolCall): string {
  if (call.type !== "function" || !call.function?.name) return "";
  return `${call.function.name}:${call.function.arguments ?? ""}`;
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty args
  }
  return {};
}

function addUsage(into: ChatUsage, add?: ChatUsage): void {
  if (!add) return;
  if (add.promptTokens != null) into.promptTokens = (into.promptTokens ?? 0) + add.promptTokens;
  if (add.completionTokens != null) {
    into.completionTokens = (into.completionTokens ?? 0) + add.completionTokens;
  }
  if (add.totalTokens != null) into.totalTokens = (into.totalTokens ?? 0) + add.totalTokens;
}

/**
 * Progress-driven tool-call loop over an injected {@link CompleteRound}. Pure of
 * any provider SDK, so it is unit-testable with a fake completion function.
 */
export async function runToolLoop(params: RunToolLoopParams): Promise<ToolLoopResult> {
  const conversation = [...params.seed];
  const usage: ChatUsage = {};
  const seen = new Set<string>();
  let latencyMs = 0;
  let stalls = 0;
  let rounds = 0;
  let lastRaw: unknown = null;

  for (;;) {
    if (params.maxRounds != null && rounds >= params.maxRounds) {
      return { content: "", usage, latencyMs, rounds, responseBody: lastRaw, loopDetected: true };
    }

    const round = await params.complete(conversation);
    rounds += 1;
    latencyMs += round.latencyMs;
    addUsage(usage, round.usage);
    lastRaw = round.raw;

    const toolCalls = round.toolCalls;
    if (toolCalls.length === 0) {
      return {
        content: round.content,
        usage,
        latencyMs,
        rounds,
        responseBody: round.raw,
        loopDetected: false,
      };
    }

    // Stall guard: a round is progress if it introduces a call we have not run.
    const introducesNew = toolCalls.some((c) => !seen.has(toolCallSignature(c)));
    if (introducesNew) {
      stalls = 0;
    } else if ((stalls += 1) >= MAX_STALL_ROUNDS) {
      return { content: "", usage, latencyMs, rounds, responseBody: lastRaw, loopDetected: true };
    }

    conversation.push(round.assistantMessage);

    for (const call of toolCalls) {
      if (call.type !== "function" || !call.function?.name) continue;
      seen.add(toolCallSignature(call));
      const name = call.function.name;
      const args = parseToolArguments(call.function.arguments);

      let result: McpToolCallResult;
      let ok = true;
      try {
        result = await params.callTool(name, args);
        ok = !result.isError;
      } catch (err) {
        ok = false;
        result = { text: err instanceof Error ? err.message : "Tool execution failed", isError: true };
      }

      await params.onToolCall?.({ name, args, result, ok });
      conversation.push({ role: "tool", tool_call_id: call.id, content: result.text });
    }
  }
}

/**
 * Map our chat turns to OpenAI message params. Roles map 1:1; content is either
 * plain text or (for a vision `user` turn) an array of text/image parts, both of
 * which the SDK's user-message param accepts — the cast bridges our simplified
 * union to the role-specific param types.
 */
function toSeedMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam);
}

function mapUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): ChatUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

/**
 * Generate a chat completion with tool support against an OpenAI-compatible
 * endpoint. Returns the same {@link ChatCompletionResult} shape as
 * {@link chatCompletion} so the caller records request/response bodies and usage
 * uniformly. Throws a clean {@link ApiError} on provider failure or when the loop
 * ends without an answer (a stall or empty final content).
 */
export async function chatCompletionWithTools(
  conn: LlmConnection,
  input: {
    model: string;
    messages: ChatMessage[];
    tools: ChatCompletionTool[];
    callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
    onToolCall?: (record: ToolCallRecord) => void | Promise<void>;
    /** Reports the exact initial request body just before the first round is sent. */
    onRequest?: (requestBody: unknown) => void | Promise<void>;
    maxRounds?: number;
    timeoutMs?: number;
  },
): Promise<ChatCompletionResult> {
  const seed = toSeedMessages(input.messages);
  const requestBody = { model: input.model, messages: seed, tools: input.tools };
  const client = createOpenAiClient(conn);
  const timeout = input.timeoutMs ?? CHAT_COMPLETION_TIMEOUT_MS;

  // Report the initial request body (model + messages + tools) before the first
  // round so the trace records what the model was actually sent, in order — the
  // request precedes any tool-call events the loop then produces.
  await input.onRequest?.(requestBody);

  const complete: CompleteRound = async (conversation) => {
    const start = Date.now();
    try {
      const completion = await client.chat.completions.create(
        { model: input.model, messages: conversation, tools: input.tools },
        { timeout },
      );
      const latencyMs = Date.now() - start;
      const message = completion.choices[0]?.message;
      return {
        assistantMessage: (message ?? { role: "assistant", content: "" }) as ChatCompletionMessageParam,
        toolCalls: message?.tool_calls ?? [],
        content: message?.content?.trim() ?? "",
        usage: mapUsage(completion.usage),
        latencyMs,
        raw: completion,
      };
    } catch (err) {
      throw toLlmError(err, conn.baseUrl);
    }
  };

  const result = await runToolLoop({
    seed,
    complete,
    callTool: input.callTool,
    onToolCall: input.onToolCall,
    maxRounds: input.maxRounds,
  });

  if (result.loopDetected || !result.content) {
    throw ApiError.serviceUnavailable(
      result.loopDetected
        ? "LLM tool loop stalled without producing a reply"
        : "LLM returned an empty response",
    );
  }

  return {
    content: result.content,
    model: input.model,
    // The loop's last round, which is the response that produced the answer. This
    // used to be dropped on the floor: the loop returned only the requested id, so
    // a reply made with tools recorded a different model name than the identical
    // reply made without them.
    servedModel: servedModelOf(result.responseBody),
    usage: result.usage,
    latencyMs: result.latencyMs,
    requestBody,
    responseBody: result.responseBody,
  };
}
