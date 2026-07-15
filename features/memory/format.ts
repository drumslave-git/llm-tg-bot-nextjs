/**
 * Prompt-context formatting for memory. Pure/client-safe (mirrors
 * `features/known-users/format.ts` and `features/self-improvement/format.ts`):
 * the server service resolves the data, these functions shape the text injected
 * into the reply prompt.
 *
 * Only `user` memory is injected — the durable picture of the people actually in
 * this conversation. General memory is retrieved by tool instead: it spans every
 * chat and grows without bound, so injecting it wholesale would bloat every reply
 * with facts irrelevant to the question.
 *
 * Only *consolidated* memory is injected: the pending queue is not folded in (user
 * decision). What the model sees is the merged, deduplicated, contradiction-resolved
 * picture — not a running log of every note ever saved.
 */

/** One person's memory, ready to render. */
export interface UserMemoryBlock {
  /** Human label of the person (known-user label shape). */
  label: string;
  /** Whether this person is the one who sent the message being answered. */
  isSender: boolean;
  /** Durable facts about them, one per line, most-durable first. */
  facts: string[];
}

/** Split a stored memory document into its individual fact lines. */
export function splitMemoryFacts(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * The long-term memory block injected as a system message on a reply: what the
 * bot durably knows about the people in this conversation. Returns null when it
 * knows nothing about anyone here (nothing useful to inject).
 *
 * The sender is marked, because in a group the model must not confuse a fact
 * about a bystander with a fact about the person it is answering.
 */
export function formatMemoryContext(blocks: UserMemoryBlock[]): string | null {
  const usable = blocks.filter((block) => block.facts.length > 0);
  if (usable.length === 0) return null;

  const lines = [
    "Long-term memory — what you durably know about the people in this conversation:",
  ];
  for (const block of usable) {
    const who = block.isSender ? `${block.label} (the person you are replying to)` : block.label;
    lines.push(`${who}:`);
    for (const fact of block.facts) lines.push(`- ${fact}`);
  }
  lines.push(
    "Use this to stay consistent with what you already know. Do not recite it back unprompted, " +
      "and do not treat it as more current than what is said in this conversation.",
  );
  return lines.join("\n");
}
