import "server-only";

import { ApiError } from "@/lib/api-error";

import { createOpenAiClient, listModels, toLlmError, type LlmConnection } from "./client";

/**
 * Shared client for OpenAI-compatible `/v1/images/generations` endpoints — the
 * third sibling of {@link import("./client")} (chat) and
 * {@link import("./embeddings")} (vectors).
 *
 * Image generation almost never comes from the chat model, and often not even
 * from the same host (a diffusion model rarely lives beside the LLM), so the
 * connection is passed in explicitly; the settings service resolves it from the
 * DB, falling back to the LLM connection when no image base URL is configured.
 *
 * Images are always requested as base64 (`b64_json`): Ollama's image endpoint and
 * the GPT image models return no URLs, so there is nothing else to ask for.
 */

/**
 * Generation is far slower than chat — a diffusion model can spend minutes on one
 * image, and the caller is a background-ish tool call, not a page render.
 */
const IMAGE_TIMEOUT_MS = 300_000;

/** Short timeout for the Settings probe, which only lists models. */
const PROBE_TIMEOUT_MS = 15_000;

/** Image dimensions as [width, height] in pixels. */
export type ImageSize = [number, number];

/** Default size when the model does not ask for one. */
export const DEFAULT_IMAGE_SIZE: ImageSize = [1024, 1024];

/** A resolved image connection: where to call, and which model to ask for. */
export interface ImageRuntime extends LlmConnection {
  model: string;
}

export interface GenerateImagesInput {
  prompt: string;
  size?: ImageSize;
}

/**
 * Generate one or more images from a prompt, returning the base64 payloads in the
 * order the endpoint produced them. Throws a clean {@link ApiError} on provider
 * failure, or when the endpoint answers without any image data (a success status
 * with an empty payload is a failure from the caller's point of view — there is
 * nothing to send to the chat).
 */
export async function generateImages(
  runtime: ImageRuntime,
  input: GenerateImagesInput,
): Promise<string[]> {
  const size = input.size ?? DEFAULT_IMAGE_SIZE;
  try {
    const response = await createOpenAiClient(runtime).images.generate(
      {
        model: runtime.model,
        prompt: input.prompt,
        size: `${size[0]}x${size[1]}`,
        response_format: "b64_json",
      },
      { timeout: IMAGE_TIMEOUT_MS },
    );
    const images = (response.data ?? [])
      .map((item) => item.b64_json)
      .filter((b64): b64 is string => Boolean(b64));
    if (images.length === 0) {
      throw ApiError.serviceUnavailable("Image endpoint returned no image data");
    }
    return images;
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** What a connection test learned about the configured image endpoint. */
export interface ImageProbe {
  model: string;
  /** How many models the endpoint advertises (context for the operator). */
  modelCount: number;
}

/**
 * Real probe of the image configuration: calls the endpoint's model listing and
 * checks the configured model is actually served by it. Proves the host is
 * reachable, the key is accepted, and the model id is not a typo.
 *
 * Deliberately does **not** generate an image. Unlike the embedding probe — where
 * a real call is the only way to learn the vector width, which silently corrupts
 * inserts if wrong — nothing about a generated image can only be learned by
 * generating one, and a diffusion model can spend minutes on it. A Settings
 * button that hangs for two minutes teaches the operator to stop pressing it.
 */
export async function probeImages(runtime: ImageRuntime): Promise<ImageProbe> {
  const models = await listModels(runtime, PROBE_TIMEOUT_MS);
  if (!models.includes(runtime.model)) {
    throw ApiError.badRequest(
      `Image model "${runtime.model}" is not served by ${runtime.baseUrl}. ` +
        (models.length > 0
          ? `Available models: ${models.slice(0, 10).join(", ")}${models.length > 10 ? ", …" : ""}.`
          : "The endpoint advertises no models."),
    );
  }
  return { model: runtime.model, modelCount: models.length };
}
