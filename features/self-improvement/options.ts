import type { FeedbackReaction } from "./types";

/**
 * Predefined feedback menu options (user decision, 2026-07-14). Five per
 * reaction plus a free-text "Other". Code constants — the stored feedback is the
 * option's text, so renaming an option later does not corrupt stored rows.
 */

/** What the user liked (👍 menu). */
export const LIKE_OPTIONS = [
  "Helpful & accurate",
  "Right tone/personality",
  "Good length & format",
  "Funny/entertaining",
  "Understood the context",
] as const;

/** What the user disliked (👎 menu). */
export const DISLIKE_OPTIONS = [
  "Inaccurate or wrong",
  "Wrong tone",
  "Too long or rambling",
  "Missed the point/context",
  "Generic or boring",
] as const;

/** Label of the free-text option button. */
export const OTHER_OPTION_LABEL = "Other — write your own";

/** The predefined option list for a reaction. */
export function optionsForReaction(reaction: FeedbackReaction): readonly string[] {
  return reaction === "up" ? LIKE_OPTIONS : DISLIKE_OPTIONS;
}
