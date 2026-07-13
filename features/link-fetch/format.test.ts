import { describe, expect, it } from "vitest";

import { formatLinkFetchContext, formatLinkFetchFailure } from "./format";

describe("formatLinkFetchContext", () => {
  it("renders title and content for a read page", () => {
    const out = formatLinkFetchContext({
      url: "https://example.com",
      title: "Example Domain",
      text: "This domain is for use in examples.",
    });
    expect(out).toContain("Read page: https://example.com");
    expect(out).toContain("Title: Example Domain");
    expect(out).toContain("Content:\nThis domain is for use in examples.");
    expect(out).toContain("Do not tell the user you cannot open links");
  });

  it("omits the title line when there is no title", () => {
    const out = formatLinkFetchContext({ url: "https://example.com", title: "", text: "body" });
    expect(out).not.toContain("Title:");
    expect(out).toContain("Content:\nbody");
  });

  it("flags an empty body rather than pretending there was content", () => {
    const out = formatLinkFetchContext({ url: "https://example.com", title: "T", text: "" });
    expect(out).toContain("(page had no readable text)");
  });

  it("renders a per-page error and tells the model not to invent contents", () => {
    const out = formatLinkFetchContext({
      url: "https://blocked.example",
      title: "",
      text: "",
      error: "URL blocked for safety (private network or unsupported scheme)",
    });
    expect(out).toContain("Failed to read: URL blocked for safety");
    expect(out).toContain("Do not invent its contents.");
    expect(out).not.toContain("Content:");
  });
});

describe("formatLinkFetchFailure", () => {
  it("reports the failure and forbids pretending success", () => {
    const out = formatLinkFetchFailure("https://example.com", new Error("navigation timeout"));
    expect(out).toContain("Reading the page https://example.com failed: navigation timeout");
    expect(out).toContain("Do not pretend you opened the link.");
  });
});
