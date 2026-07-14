import { describe, it } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the scheduled-tasks MCP tools. Skipped
 * unless `LLM_LIVE=1`. Tools are never executed — each call is recorded and answered
 * with a canned result (see {@link runToolSelection}). The canned `tasks_list` result
 * carries a task id, so the update/delete flows can complete the natural two-step
 * (list to find the task, then act on it).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("scheduled-tasks MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "creates a scheduled task from a reminder request",
    async () => {
      const run = await runToolSelection({
        userText: "Set up a reminder every day at 9am to drink water.",
      });
      expectToolCalled(run, "tasks_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "lists scheduled tasks when asked what's scheduled",
    async () => {
      const run = await runToolSelection({
        userText: "What reminders do I currently have scheduled?",
      });
      expectToolCalled(run, "tasks_list");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "updates a scheduled task (list to find it, then change it)",
    async () => {
      const run = await runToolSelection({
        userText: "Change my daily water reminder to 8am instead of 9am.",
      });
      expectToolCalled(run, "tasks_update");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "deletes a scheduled task when asked to cancel it",
    async () => {
      const run = await runToolSelection({
        userText: "Cancel my daily water reminder, I don't need it anymore.",
      });
      expectToolCalled(run, "tasks_delete");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "gets one scheduled task's details by id",
    async () => {
      const run = await runToolSelection({
        priorTurns: [
          { role: "assistant", content: "You have one task — task_demo_1: daily at 09:00." },
        ],
        userText: "Show me the full details of the scheduled task task_demo_1.",
      });
      expectToolCalled(run, "tasks_get");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
