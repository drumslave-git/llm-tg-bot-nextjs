import "server-only";

import type { LlmCallKindId } from "@/features/analytics/llm-call-kind";
import {
  isContextOverflowError,
  llmUsageOf,
  type ChatCompletionResult,
  type ChatMessage,
} from "@/server/llm/client";
import type { TraceRecorder } from "@/server/trace";

import {
  batchMessages,
  MIN_SUMMARY_BATCH_CHARS,
  SUMMARY_BATCH_CHARS,
  type SummarizableMessage,
} from "../summary";

/**
 * Run one traced LLM pass per transcript batch — the loop shared by the two
 * whole-day jobs (history summarization and memory extraction), which differ
 * only in the prompt they build and the parser they feed the responses to.
 *
 * The char budget is a guess at what fits the model: it cannot see tokenization,
 * so a batch the budget accepted can still be rejected by the endpoint as too
 * large. When that happens the not-yet-summarized messages are re-batched at
 * half the budget and the pass retried, down to {@link MIN_SUMMARY_BATCH_CHARS};
 * batches that already completed are kept. Any other failure propagates — the
 * day stays pending and the caller's trace records it.
 */
export async function completeTranscriptBatches(params: {
  messages: readonly SummarizableMessage[];
  /** The full request for one batch (system prompt + the batch's transcript). */
  buildRequest: (batch: readonly SummarizableMessage[]) => ChatMessage[];
  complete: (messages: ChatMessage[]) => Promise<ChatCompletionResult>;
  trace: Pick<TraceRecorder, "event">;
  callKind: LlmCallKindId;
}): Promise<string[]> {
  const { trace } = params;
  let budget = SUMMARY_BATCH_CHARS;
  let queue: readonly SummarizableMessage[] = params.messages;
  const contents: string[] = [];

  const initialBatches = batchMessages(queue, budget).length;
  if (initialBatches > 1) {
    await trace.event({
      type: "step",
      message: "transcript batched",
      data: { batches: initialBatches, reason: "day exceeds one model pass" },
    });
  }

  while (queue.length > 0) {
    const remaining = batchMessages(queue, budget);
    const batch = remaining[0];
    const total = contents.length + remaining.length;
    const label = total > 1 ? ` (batch ${contents.length + 1}/${total})` : "";
    const request = params.buildRequest(batch);

    await trace.event({
      type: "llm_request",
      message: `request${label}`,
      data: { messages: request },
    });

    let completion: ChatCompletionResult;
    try {
      completion = await params.complete(request);
    } catch (err) {
      if (isContextOverflowError(err) && budget > MIN_SUMMARY_BATCH_CHARS) {
        budget = Math.max(Math.floor(budget / 2), MIN_SUMMARY_BATCH_CHARS);
        await trace.event({
          type: "step",
          level: "warn",
          message: `batch exceeded the model context — re-batching at ${budget} chars`,
          data: {
            budgetChars: budget,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        continue;
      }
      throw err;
    }

    await trace.event({
      type: "llm_response",
      message: `response${label}`,
      data: completion.responseBody ?? { content: completion.content },
      usage: { ...llmUsageOf(completion), callKind: params.callKind },
    });
    contents.push(completion.content);
    queue = queue.slice(batch.length);
  }

  return contents;
}
