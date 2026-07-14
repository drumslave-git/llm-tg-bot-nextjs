/**
 * Client-safe types for the self-improvement feature: user feedback collected
 * via 👍/👎 reactions, and the versioned artifacts the daily job distills from
 * it (per-user communication preferences + global self-corrections).
 */

/** Which thumb the user reacted with. */
export type FeedbackReaction = "up" | "down";

/**
 * Feedback lifecycle: menu sent (`pending`) → user tapped "Other" and we await
 * their reply to the menu message (`awaiting_text`) → answer stored
 * (`completed`).
 */
export type FeedbackStatus = "pending" | "awaiting_text" | "completed";

/** One collected feedback row (client-safe). */
export interface UserFeedback {
  id: string;
  chatId: string;
  /** Telegram message id of the reacted bot reply. */
  telegramMessageId: number;
  userId: string;
  reaction: FeedbackReaction;
  /** The chosen option text or the user's own words; null until answered. */
  feedback: string | null;
  status: FeedbackStatus;
  /** Clean model name that generated the reacted reply (informational). */
  model: string;
  /** Preferences version that incorporated this feedback, or null. */
  prefsVersion: number | null;
  /** Self-corrections version that incorporated this feedback, or null. */
  correctionsVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One versioned per-user preferences snapshot (client-safe). */
export interface CommunicationPreference {
  id: string;
  userId: string;
  model: string;
  likes: string;
  dislikes: string;
  version: number;
  createdAt: string;
}

/** One versioned global self-correction snapshot (client-safe). */
export interface SelfCorrection {
  id: string;
  model: string;
  correction: string;
  version: number;
  createdAt: string;
}
