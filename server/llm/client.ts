import "server-only";

import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "openai";

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

/** Normalize any base URL to its OpenAI-compatible `/v1` form. */
export function toOpenAiBaseUrl(base: string): string {
  const host = base.trim().replace(/\/+$/, "");
  if (!host) throw ApiError.badRequest("LLM base URL is required");
  return host.endsWith("/v1") ? host : `${host}/v1`;
}

function client(conn: LlmConnection): OpenAI {
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
function toLlmError(err: unknown, baseUrl: string): ApiError {
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
 * key (if any) is accepted.
 */
export async function listModels(conn: LlmConnection): Promise<string[]> {
  try {
    const page = await client(conn).models.list({ timeout: LIST_MODELS_TIMEOUT_MS });
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
