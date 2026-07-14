import { updateScheduledTaskSchema } from "@/features/scheduled-tasks/server/schema";
import {
  editScheduledTaskService,
  removeScheduledTaskService,
} from "@/features/scheduled-tasks/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single scheduled-task API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence, schedule recomputation, and traces.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateScheduledTaskSchema);
  return ok(await editScheduledTaskService(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeScheduledTaskService(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
