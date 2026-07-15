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
 * Opt-in live tool-selection coverage for the link-reader MCP tool. Skipped unless
 * `LLM_LIVE=1`. No headless browser is launched — the call is recorded and answered
 * with a canned result (see {@link runToolSelection}).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("link-fetch MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "reads a page when given a link to look at",
    async () => {
      const run = await runToolSelection({
        userText: "Have a look at https://example.com/article and tell me what it's about.",
      });
      expectToolCalled(run, "read_page");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "reads (not searches) a bare URL the user drops in with 'what's this'",
    async () => {
      // Regression: a bare URL + "tell me what's there" must read the page,
      // not fire a web search for it (the URL is already known).
      const run = await runToolSelection({
        userText: "https://example.com/package/some-lib tell me what's there",
      });
      expectToolCalled(run, "read_page");
      expectToolNotCalled(run, "search_web");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
