import { describe, expect, it, vi } from "vitest";

import type { FetchedPage } from "../types";
import { fetchLink } from "./fetch-link";

/**
 * The read-link boundary. The page fetcher is injected so these run without a
 * real browser; they cover URL validation, the SSRF guard, and the never-throw
 * success/failure contract the MCP tool relies on.
 */

describe("fetchLink", () => {
  it("reads a page and formats its content, calling the fetcher with the normalized URL", async () => {
    const page: FetchedPage = { url: "https://example.com/", title: "Example", text: "Hello world" };
    const fetchPage = vi.fn(async () => page);

    const out = await fetchLink("  https://example.com  ", { fetchPage });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith("https://example.com/");
    expect(out.resolved).toBe(true);
    expect(out.reason).toBe("Page read");
    expect(out.context).toContain("Title: Example");
    expect(out.context).toContain("Hello world");
  });

  it("rejects an invalid URL without calling the fetcher", async () => {
    const fetchPage = vi.fn(async (): Promise<FetchedPage> => ({ url: "", title: "", text: "" }));

    const out = await fetchLink("not a url", { fetchPage });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(out.resolved).toBe(false);
    expect(out.page.error).toContain("not a valid http(s) link");
  });

  it("blocks an SSRF target without calling the fetcher", async () => {
    const fetchPage = vi.fn(async (): Promise<FetchedPage> => ({ url: "", title: "", text: "" }));

    const out = await fetchLink("http://127.0.0.1/admin", { fetchPage });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(out.resolved).toBe(false);
    expect(out.page.error).toContain("blocked for safety");
    expect(out.context).toContain("Do not invent its contents.");
  });

  it("surfaces a per-page read error as an unresolved result (not a throw)", async () => {
    const fetchPage = vi.fn(
      async (url: string): Promise<FetchedPage> => ({ url, title: "", text: "", error: "HTTP 404" }),
    );

    const out = await fetchLink("https://example.com/missing", { fetchPage });

    expect(out.resolved).toBe(false);
    expect(out.reason).toBe("HTTP 404");
    expect(out.context).toContain("Failed to read: HTTP 404");
  });

  it("recovers from a thrown fetcher error with a failure message", async () => {
    const fetchPage = vi.fn(async (): Promise<FetchedPage> => {
      throw new Error("browser crashed");
    });

    const out = await fetchLink("https://example.com", { fetchPage });

    expect(out.resolved).toBe(false);
    expect(out.reason).toBe("browser crashed");
    expect(out.context).toContain("Reading the page https://example.com/ failed: browser crashed");
    expect(out.context).toContain("Do not pretend you opened the link.");
  });
});
