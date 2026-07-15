import { createGeneralMemorySchema } from "@/features/memory/server/schema";
import { addGeneralMemory } from "@/features/memory/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * General-memory collection API. Thin handler: shared wrappers own validation and
 * error mapping; the service owns embedding, persistence, and trace recording.
 * (Reads come from the aggregate view at `GET /api/memory`.)
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createGeneralMemorySchema);
  return ok(await addGeneralMemory(input));
});
