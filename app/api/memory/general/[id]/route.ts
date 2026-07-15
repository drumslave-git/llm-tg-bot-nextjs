import { updateGeneralMemorySchema } from "@/features/memory/server/schema";
import { editGeneralMemory, forgetGeneralMemory } from "@/features/memory/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/** Single general-fact API: rewrite (re-embedding it) or forget one fact. */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateGeneralMemorySchema);
  return ok(await editGeneralMemory(params.id, input));
});

export const DELETE = defineRoute(async ({ params }) => {
  await forgetGeneralMemory(params.id);
  return ok({ deleted: true });
});
