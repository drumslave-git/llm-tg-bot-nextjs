import { describe, it } from "vitest";

import {
  expectToolCalled,
  expectToolNotCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the web-search MCP tool. Skipped unless
 * `LLM_LIVE=1`. No real Tavily request is made — the call is recorded and answered
 * with a canned result (see {@link runToolSelection}).
 *
 * Includes the important negative case: the model must NOT search the web for plain
 * general knowledge, matching the tool's "only when explicitly asked" contract.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("web-search MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "searches the web when explicitly asked to look something up online",
    async () => {
      const run = await runToolSelection({
        userText: "Search the web for the latest news about the Mars Sample Return mission.",
      });
      expectToolCalled(run, "search_web");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "does NOT web-search for plain general knowledge",
    async () => {
      const run = await runToolSelection({ userText: "What's the capital of France?" });
      expectToolNotCalled(run, "search_web");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
