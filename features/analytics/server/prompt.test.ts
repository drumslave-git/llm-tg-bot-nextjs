import { describe, expect, it } from "vitest";

import {
  buildPeriodInsightRequest,
  formatTranscript,
  parseDayInsight,
  parsePeriodInsight,
} from "./prompt";

describe("parseDayInsight", () => {
  it("parses a well-formed object", () => {
    const out = parseDayInsight(
      '{"moodScore":72,"moodLabel":"warm","moodSummary":"friendly banter","topTopic":"weekend plans"}',
    );
    expect(out).toEqual({
      moodScore: 72,
      moodLabel: "warm",
      moodSummary: "friendly banter",
      topTopic: "weekend plans",
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const out = parseDayInsight('Here it is:\n```json\n{"moodScore":40,"topTopic":"bug reports"}\n```');
    expect(out?.moodScore).toBe(40);
    expect(out?.topTopic).toBe("bug reports");
    // Missing label is derived from the score.
    expect(out?.moodLabel).toBe("tense");
  });

  it("clamps an out-of-range score", () => {
    expect(parseDayInsight('{"moodScore":250,"topTopic":"x"}')?.moodScore).toBe(100);
  });

  it("fails closed when the topic or score is missing", () => {
    expect(parseDayInsight('{"moodScore":50}')).toBeNull();
    expect(parseDayInsight('{"topTopic":"x"}')).toBeNull();
    expect(parseDayInsight("not json at all")).toBeNull();
  });
});

describe("parsePeriodInsight", () => {
  it("parses word + topic", () => {
    expect(parsePeriodInsight('{"wordOfPeriod":"deadlines","topTopic":"release planning"}')).toEqual({
      wordOfPeriod: "deadlines",
      topTopic: "release planning",
    });
  });

  it("fails closed when either field is missing", () => {
    expect(parsePeriodInsight('{"wordOfPeriod":"x"}')).toBeNull();
    expect(parsePeriodInsight('{"topTopic":"y"}')).toBeNull();
    expect(parsePeriodInsight("{}")).toBeNull();
  });
});

describe("formatTranscript", () => {
  it("labels roles and drops empty messages", () => {
    const text = formatTranscript([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "   " },
    ]);
    expect(text).toBe("User: hi there\nBot: hello!");
  });
});

describe("buildPeriodInsightRequest", () => {
  it("lists each day with its mood and topic", () => {
    const req = buildPeriodInsightRequest({
      granularity: "month",
      bucket: "2026-07",
      days: [{ insightDate: "2026-07-01", moodLabel: "positive", topTopic: "launch", messageCount: 12 }],
    });
    expect(req).toContain("month 2026-07");
    expect(req).toContain("2026-07-01 — mood positive — topic: launch (12 msgs)");
  });
});
