import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { ApiError } from "@/lib/api-error";

/**
 * Shared client for OpenAI-compatible LLM endpoints. Server-only. The connection
 * (base URL + optional API key) is passed in explicitly — it comes from DB-backed
 * settings, not env vars — so the same client serves the settings "test
 * connection" probe and, later, the conversation core.
 */

export interface LlmConnection {
  baseUrl: string;
  apiKey?: string | null;
}

const LIST_MODELS_TIMEOUT_MS = 15_000;
export const CHAT_COMPLETION_TIMEOUT_MS = 120_000;

/**
 * A single content part of a multimodal message. Only `user` turns carry image
 * parts (a data: URL with base64 JPEG); text parts and plain string content
 * behave identically to a text-only turn.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** A single chat turn sent to the model. Content is plain text, or — for a
 * vision turn — an array of text/image parts. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

/** Normalized token usage for a completion, when the provider reports it. */
export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Result of a chat completion: the assistant text plus metadata for tracing. */
export interface ChatCompletionResult {
  content: string;
  model: string;
  usage?: ChatUsage;
  latencyMs: number;
  /** Exact request payload sent to the endpoint (for Debug bodies). */
  requestBody: unknown;
  /** Raw response object returned by the endpoint (for Debug bodies). */
  responseBody: unknown;
}

/**
 * Replace inline image bytes in a message list with a compact marker for trace
 * recording. A vision turn carries a `data:image/...;base64,<~1MB>` URL per
 * image; storing that verbatim in a trace would bloat the row and make the Debug
 * JSON unreadable. The bytes are not lost — the actual image is persisted in
 * `message_media` and shown on the Vision page — so here we keep everything the
 * operator reads (roles, text, structure) and swap each data URL for
 * `data:<mime>;base64,<N bytes>`. Non-image content is returned unchanged.
 */
export function sanitizeMessagesForTrace(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      if (part.type !== "image_url") return part;
      const url = part.image_url.url;
      const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(url);
      if (!match) return part;
      const [, mime, data] = match;
      return {
        type: "image_url" as const,
        image_url: { url: `data:${mime};base64,<${data.length} bytes>` },
      };
    });
    return { ...message, content };
  });
}

/**
 * Redact a full chat-completion request body for trace recording: the exact
 * object sent to the provider (`model`, `messages`, `tools`, and any other params)
 * is preserved verbatim except that inline image bytes in `messages` are swapped
 * for a compact `data:<mime>;base64,<N bytes>` marker (see
 * {@link sanitizeMessagesForTrace}). Non-object bodies pass through unchanged.
 */
export function sanitizeRequestBodyForTrace<T>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;
  return { ...body, messages: sanitizeMessagesForTrace(messages as ChatMessage[]) };
}

/** Normalize any base URL to its OpenAI-compatible `/v1` form. */
export function toOpenAiBaseUrl(base: string): string {
  const host = base.trim().replace(/\/+$/, "");
  if (!host) throw ApiError.badRequest("LLM base URL is required");
  return host.endsWith("/v1") ? host : `${host}/v1`;
}

/** Construct an OpenAI SDK client for an OpenAI-compatible endpoint. */
export function createOpenAiClient(conn: LlmConnection): OpenAI {
  return new OpenAI({
    apiKey: conn.apiKey?.trim() || "not-needed",
    baseURL: toOpenAiBaseUrl(conn.baseUrl),
    maxRetries: 0,
  });
}

function apiErrorDetail(err: APIError): string {
  if (typeof err.error === "string") return err.error;
  if (err.error && Object.keys(err.error).length > 0) return JSON.stringify(err.error);
  return err.message;
}

/** Map provider/network failures to a clean {@link ApiError} without leaking internals. */
export function toLlmError(err: unknown, baseUrl: string): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return ApiError.serviceUnavailable(`Connection to ${baseUrl} timed out`);
  }
  if (err instanceof APIConnectionError) {
    return ApiError.serviceUnavailable(`Could not connect to ${baseUrl}: ${err.message}`);
  }
  if (err instanceof APIError) {
    // 401/403 mean the key/config is wrong (a user-fixable request error);
    // anything else from the endpoint is treated as it being unavailable.
    const code = err.status === 401 || err.status === 403 ? "bad_request" : "service_unavailable";
    return new ApiError(code, `LLM endpoint error (${err.status ?? "unknown"}): ${apiErrorDetail(err)}`);
  }
  return ApiError.serviceUnavailable(err instanceof Error ? err.message : String(err));
}

/**
 * List distinct model ids from an OpenAI-compatible endpoint, sorted. Doubles as
 * the connection health probe: success proves the endpoint is reachable and the
 * key (if any) is accepted. `timeoutMs` bounds the wait (shorter for status
 * dashboards, longer for an explicit test).
 */
export async function listModels(
  conn: LlmConnection,
  timeoutMs: number = LIST_MODELS_TIMEOUT_MS,
): Promise<string[]> {
  try {
    const page = await createOpenAiClient(conn).models.list({ timeout: timeoutMs });
    const seen = new Set<string>();
    for (const entry of page.data ?? []) {
      const id = (entry.id ?? "").trim();
      if (id) seen.add(id);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw toLlmError(err, conn.baseUrl);
  }
}

/**
 * Generate a chat completion from an OpenAI-compatible endpoint. Returns the
 * assistant's reply text plus model/usage/latency for trace recording. Throws a
 * clean {@link ApiError} on provider/network failure, and `service_unavailable`
 * if the endpoint returns no assistant content.
 */
export async function chatCompletion(
  conn: LlmConnection,
  input: {
    model: string;
    messages: ChatMessage[];
    timeoutMs?: number;
    /** Reports the exact request body just before it is sent (for trace recording). */
    onRequest?: (requestBody: unknown) => void | Promise<void>;
  },
): Promise<ChatCompletionResult> {
  const requestBody = {
    model: input.model,
    messages: input.messages as ChatCompletionMessageParam[],
  };
  const start = Date.now();
  try {
    await input.onRequest?.(requestBody);
    const completion = await createOpenAiClient(conn).chat.completions.create(requestBody, {
      timeout: input.timeoutMs ?? CHAT_COMPLETION_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - start;
    const content = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!content) {
      throw ApiError.serviceUnavailable("LLM returned an empty response");
    }
    return {
      content,
      model: completion.model || input.model,
      usage: completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens,
            completionTokens: completion.usage.completion_tokens,
            totalTokens: completion.usage.total_tokens,
          }
        : undefined,
      latencyMs,
      requestBody,
      responseBody: completion,
    };
  } catch (err) {
    throw toLlmError(err, conn.baseUrl);
  }
}
