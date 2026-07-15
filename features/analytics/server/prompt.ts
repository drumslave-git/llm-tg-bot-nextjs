/**
 * Prompt building + strict-JSON parsing for the analytics insight job. Pure and
 * dependency-free so the parsers (the fail-closed boundary) are unit-testable
 * without an LLM.
 */

import { clampMoodScore, moodLabelForScore } from "../mood";
import type { PeriodGranularity } from "../types";

/** Cap on transcript characters fed to one day-insight call, to bound tokens. */
const TRANSCRIPT_CHAR_CAP = 12_000;

export const DAY_INSIGHT_PROMPT = [
  "You are an analytics assistant. You read ONE day of one chat's conversation and",
  "describe it as a strict JSON object with exactly these fields:",
  '- "moodScore": integer 0–100 (0 = very negative/hostile, 50 = neutral, 100 = very positive/warm),',
  "  judged from the human participants' tone.",
  '- "moodLabel": 1–2 word mood (e.g. "positive", "tense", "neutral").',
  '- "moodSummary": one short sentence explaining the mood.',
  '- "topTopic": the single most-discussed topic, as a short noun phrase.',
  "Respond with ONLY the JSON object — no prose, no markdown, no code fences.",
].join("\n");

export const PERIOD_INSIGHT_PROMPT = [
  "You are an analytics assistant. Given a period's daily topics and moods, return a",
  "strict JSON object with exactly these fields:",
  '- "wordOfPeriod": a SINGLE word that best characterizes the period — the most',
  "  emblematic word of what was discussed or how it felt.",
  '- "topTopic": the single most-discussed topic across the whole period, as a short noun phrase.',
  "Respond with ONLY the JSON object — no prose, no markdown, no code fences.",
].join("\n");

/** Render a day's messages as a bounded, role-labelled transcript. */
export function formatTranscript(
  messages: { role: "user" | "assistant"; content: string }[],
): string {
  const lines = messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => `${m.role === "assistant" ? "Bot" : "User"}: ${m.content.replace(/\s+/g, " ").trim()}`);
  let text = lines.join("\n");
  if (text.length > TRANSCRIPT_CHAR_CAP) {
    // Keep the tail — the end of a day is the freshest emotional state and where
    // conclusions land.
    text = `…\n${text.slice(text.length - TRANSCRIPT_CHAR_CAP)}`;
  }
  return text;
}

/** The user message for one day-insight call. */
export function buildDayInsightRequest(input: {
  transcript: string;
  topics: string[];
}): string {
  const parts = [`Conversation (one day):\n${input.transcript}`];
  if (input.topics.length > 0) {
    parts.push(`Already-identified topics for the day:\n${input.topics.map((t) => `- ${t}`).join("\n")}`);
  }
  parts.push("Return the JSON object now.");
  return parts.join("\n\n");
}

/** The user message for one period roll-up call. */
export function buildPeriodInsightRequest(input: {
  granularity: PeriodGranularity;
  bucket: string;
  days: { insightDate: string; moodLabel: string; topTopic: string; messageCount: number }[];
}): string {
  const label =
    input.granularity === "all" ? "all time" : `${input.granularity} ${input.bucket}`;
  const lines = input.days.map(
    (d) => `${d.insightDate} — mood ${d.moodLabel} — topic: ${d.topTopic} (${d.messageCount} msgs)`,
  );
  return [
    `Period: ${label}. Daily breakdown (${input.days.length} day(s)):`,
    lines.join("\n"),
    "Return the JSON object now.",
  ].join("\n\n");
}

/** Extract the first top-level JSON object from a model response, or null. */
function extractJsonObject(content: string): Record<string, unknown> | null {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface DayInsight {
  moodScore: number;
  moodLabel: string;
  moodSummary: string;
  topTopic: string;
}

/**
 * Parse a day-insight response. Fails closed: returns null unless a topic and a
 * usable mood score are present, so a garbled response leaves the day's stored
 * insight untouched rather than overwriting it with junk.
 */
export function parseDayInsight(content: string): DayInsight | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const topTopic = asString(obj.topTopic);
  const rawScore = typeof obj.moodScore === "number" ? obj.moodScore : Number(obj.moodScore);
  if (!topTopic || !Number.isFinite(rawScore)) return null;
  const moodScore = clampMoodScore(rawScore);
  return {
    moodScore,
    moodLabel: asString(obj.moodLabel) || moodLabelForScore(moodScore),
    moodSummary: asString(obj.moodSummary),
    topTopic,
  };
}

export interface PeriodTextInsight {
  wordOfPeriod: string;
  topTopic: string;
}

/** Parse a period roll-up response. Fails closed (null unless both fields present). */
export function parsePeriodInsight(content: string): PeriodTextInsight | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const wordOfPeriod = asString(obj.wordOfPeriod);
  const topTopic = asString(obj.topTopic);
  if (!wordOfPeriod || !topTopic) return null;
  return { wordOfPeriod, topTopic };
}
