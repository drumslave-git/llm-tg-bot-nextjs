import { getTaskSchedulerStatus, runTaskSchedulerNow } from "@/features/scheduled-tasks/server/scheduler";
import { defineRoute, ok } from "@/server/http";

/**
 * Trigger one scheduled-tasks poll tick immediately (dashboard "Run due now"),
 * then report the scheduler status. Only tasks that are actually due fire.
 */
export const GET = defineRoute(async () => ok({ status: getTaskSchedulerStatus() }));

export const POST = defineRoute(async () => {
  await runTaskSchedulerNow();
  return ok({ status: getTaskSchedulerStatus() });
});
