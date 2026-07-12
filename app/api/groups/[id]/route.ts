import { updateGroupNotesSchema } from "@/features/known-groups/server/schema";
import { updateNotes } from "@/features/known-groups/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Update a known group's operator notes. Thin handler: shared wrappers own
 * validation and error mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateGroupNotesSchema);
  return ok(await updateNotes(params.id, input, { kind: "dashboard" }));
});
