import { updateAliasesSchema } from "@/features/known-users/server/schema";
import { updateAliases } from "@/features/known-users/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Update a known user's aliases. Thin handler: shared wrappers own validation
 * and error mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateAliasesSchema);
  return ok(await updateAliases(params.id, input, { kind: "dashboard" }));
});
