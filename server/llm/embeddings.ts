import "server-only";

import { ApiError } from "@/lib/api-error";
import { EMBEDDING_DIMENSIONS } from "@/lib/embeddings";

import { createOpenAiClient, toLlmError, type LlmConnection } from "./client";

/**
 * Shared client for OpenAI-compatible `/v1/embeddings` endpoints — the sibling of
 * {@link import("./client")}, and the vector half of long-term history recall.
 *
 * Embeddings usually come from a different model than chat (e.g. `bge-m3`) and
 * sometimes a different host, so the connection is passed in explicitly; the
 * settings service resolves it from the DB (falling back to the LLM connection
 * when no embedding base URL is configured).
 *
 * Every stored vector must be {@link EMBEDDING_DIMENSIONS} wide — the width the
 * `vector` columns are declared at. A model that emits a different width is a
 * configuration error we surface loudly here rather than letting Postgres reject
 * the insert deep inside a background job.
 */

const EMBEDDING_TIMEOUT_MS = 60_000;

export { EMBEDDING_DIMENSIONS };

/** A resolved embedding connection: where to call, and which model to ask for. */
export interface EmbeddingRuntime extends LlmConnection {
  model: string;
}

/**
 * Embed one or more texts, returning one vector per input in order. Throws a
 * clean {@link ApiError} on provider failure, or when the model's output width
 * does not match {@link EMBEDDING_DIMENSIONS} (which would otherwise surface as
 * an opaque Postgres type error on insert).
 */
export async function embed(
  runtime: EmbeddingRuntime,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  try {
    const response = await createOpenAiClient(runtime).embeddings.create(
      { model: runtime.model, input: texts },
      { timeout: EMBEDDING_TIMEOUT_MS },
    );
    // The API contract allows the data array to come back out of order; `index`
    // is authoritative, so place each vector rather than trusting position.
    const vectors: number[][] = new Array(texts.length);
    for (const entry of response.data ?? []) {
      vectors[entry.index] = entry.embedding as number[];
    }
    for (const [i, vector] of vectors.entries()) {
      if (!vector) {
        throw ApiError.serviceUnavailable(
          `Embedding endpoint returned no vector for input ${i}`,
        );
      }
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw ApiError.badRequest(
          `Embedding model "${runtime.model}" emits ${vector.length}-dimensional vectors, ` +
            `but this database stores ${EMBEDDING_DIMENSIONS}-dimensional ones. ` +
            `Choose a ${EMBEDDING_DIMENSIONS}-dimensional model (e.g. bge-m3).`,
        );
      }
    }
    return vectors;
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** Embed a single text. */
export async function embedOne(
  runtime: EmbeddingRuntime,
  text: string,
): Promise<number[]> {
  const [vector] = await embed(runtime, [text]);
  return vector;
}

/** What a connection test learned about the configured embedding model. */
export interface EmbeddingProbe {
  model: string;
  dimensions: number;
}

/**
 * Real probe of the embedding configuration: actually embeds a short string and
 * reports the width it got back. Proves the endpoint is reachable, the key is
 * accepted, the model exists, *and* that its vectors fit the stored columns —
 * none of which a `/v1/models` listing establishes.
 */
export async function probeEmbeddings(runtime: EmbeddingRuntime): Promise<EmbeddingProbe> {
  const vector = await embedOne(runtime, "connection test");
  return { model: runtime.model, dimensions: vector.length };
}
