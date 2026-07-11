import { z } from "zod";

/**
 * Settings validation contract — the single source of truth for the shape and
 * bounds of the DB-backed configuration. Shared by the service, the Route
 * Handlers, and the dashboard form.
 *
 * The LLM API key is a secret: it is accepted on input but never returned. The
 * client-facing {@link settingsSchema} exposes only `apiKeyConfigured`.
 */

const baseUrl = z.string().trim().url().max(500);
const model = z.string().trim().min(1).max(200);
const apiKey = z.string().trim().max(500);
const botToken = z.string().trim().max(200);

/** Settings as returned to clients — no secret values. */
export const settingsSchema = z.object({
  /** OpenAI-compatible endpoint base URL, or null when unconfigured. */
  llmBaseUrl: baseUrl.nullable(),
  /** Selected chat model id, or null when none picked. */
  model: model.nullable(),
  /** Whether an API key is stored (the value itself is never exposed). */
  apiKeyConfigured: z.boolean(),
  /** Whether a Telegram bot token is stored (the value itself is never exposed). */
  telegramBotTokenConfigured: z.boolean(),
  /** Last write time, or null if never configured. */
  updatedAt: z.string().datetime().nullable(),
});

export type Settings = z.infer<typeof settingsSchema>;

/**
 * Partial update input. Any subset may be provided; at least one field is
 * required. `apiKey` is write-only: a non-empty string sets it, an empty string
 * or null clears it, and omitting it leaves the stored key untouched.
 */
export const updateSettingsSchema = z
  .object({
    llmBaseUrl: baseUrl.nullable(),
    model: model.nullable(),
    apiKey: apiKey.nullable(),
    telegramBotToken: botToken.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one setting to update",
  });

export type UpdateSettings = z.infer<typeof updateSettingsSchema>;

/**
 * Input for the connection test. `apiKey` is optional: omit it to test with the
 * currently-stored key (useful when the URL changes but the key stays).
 */
export const testConnectionSchema = z.object({
  llmBaseUrl: baseUrl,
  apiKey: apiKey.nullable().optional(),
});

export type TestConnection = z.infer<typeof testConnectionSchema>;
