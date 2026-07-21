import { describe, expect, it } from "vitest";

import {
  expectToolCalled,
  expectToolNotCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

import { BROWSE_WEB_TOOL } from "./mcp-tools";

/**
 * Opt-in live tool-selection coverage for `browse_web`. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered
 * with a canned result — so no browser launches and no run is enqueued.
 *
 * The tool description is the one part no unit test can vouch for: its job is to
 * make the model start a browsing run when a request needs live web interaction,
 * and *not* for a quick fact or casual chat. Both directions are asserted — a
 * tool that fires on "cool website!" is worse than one that never fires.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- browser-agent/server/tool-selection`
 */
describe.skipIf(!LLM_LIVE)("browser agent tool selection (live)", () => {
  useLiveLlm();

  it(
    "browses when asked to go to a site and do something there",
    async () => {
      const run = await runToolSelection({
        userText:
          "Go to https://news.ycombinator.com, find the current top story, and tell me its title and how many points it has.",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background. Tell the user you're on it.",
            structuredContent: { ok: true, runId: "run_demo_1" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "browses (and carries the link) when the goal needs interaction beyond one page",
    async () => {
      const run = await runToolSelection({
        // "Follow the link" is a click — a genuine browsing task, not a single
        // page read (which the description tells the model to hand to read_web_page).
        userText:
          "Go to https://example.com, follow its 'More information' link, and tell me what page it leads to.",
        cannedResults: {
          [BROWSE_WEB_TOOL]: {
            text: "Browsing run started in the background.",
            structuredContent: { ok: true, runId: "run_demo_2" },
          },
        },
      });
      expectToolCalled(run, BROWSE_WEB_TOOL);
      const call = run.toolCalls.find((c) => c.name === BROWSE_WEB_TOOL);
      // The agent starts from nothing but the goal text — the link the user gave
      // must be carried into it, or the run has nowhere to begin.
      expect(String(call?.args.goal ?? "")).toContain("example.com");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "does not browse for a plain fact it already knows",
    async () => {
      const run = await runToolSelection({ userText: "What's the capital of France?" });
      expectToolNotCalled(run, BROWSE_WEB_TOOL);
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
