import { describe, it } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the known-users MCP tool. Skipped unless
 * `LLM_LIVE=1`. The tool is never executed — the call is recorded and answered with
 * a canned result (see {@link runToolSelection}).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("known-users MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "records a newly mentioned nickname for a participant",
    async () => {
      const run = await runToolSelection({
        // A DM identity context gives the model a person to attach the nickname to.
        systemContext: ["You are chatting privately with Alex (@alex)."],
        userText: "By the way, all my friends call me Sasha — remember that.",
      });
      expectToolCalled(run, "update_user_aliases");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
