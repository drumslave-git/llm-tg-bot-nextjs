import { testConnectionSchema } from "@/features/settings/server/schema";
import { testConnection } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe an OpenAI-compatible endpoint and return its available models. Backs the
 * "Test connection" action on the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testConnectionSchema);
  return ok(await testConnection(input, { kind: "dashboard" }));
});
