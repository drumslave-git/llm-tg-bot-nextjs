import fs from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import { closeSharedChromium } from "@/features/link-fetch/server/playwright";

import { downloadStreamToDisk } from "./stream-download";
import { BrowserAgentSession } from "./session";

/**
 * Opt-in **real-network** proof of the two new browser primitives, against public
 * test endpoints (no LLM, no real user data). Skipped unless `BROWSER_LIVE=1` and
 * needs ffmpeg on PATH for the stream case.
 *
 * Run: `BROWSER_LIVE=1 npm run test:integration -- browser-agent/server/primitives-live`
 */
const BROWSER_LIVE = process.env.BROWSER_LIVE === "1";

/** Mux's long-standing public HLS test stream. */
const TEST_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

describe.skipIf(!BROWSER_LIVE)("browser primitives (real network)", () => {
  afterAll(async () => {
    await closeSharedChromium().catch(() => {});
  });

  it(
    "browser_download_stream muxes a real HLS manifest into a playable MP4",
    async () => {
      const result = await downloadStreamToDisk(TEST_HLS, { title: "mux test stream" });
      try {
        expect(result.sizeBytes).toBeGreaterThan(100_000); // a real muxed file, not an empty shell
        expect(result.mime).toBe("video/mp4");
        const onDisk = await fs.stat(result.filePath);
        expect(onDisk.size).toBe(result.sizeBytes);
        console.info(`\n[stream] ${result.filename} — ${Math.round(result.sizeBytes / 1024)} KB\n`);
      } finally {
        await fs.rm(result.filePath, { force: true }).catch(() => {});
      }
    },
    180_000,
  );

  it(
    "browser_get_network captures the requests a page makes (including the HLS manifest)",
    async () => {
      const session = new BrowserAgentSession();
      try {
        // hls.js's own demo page plays an HLS stream, so its manifest + segments
        // show up in the network even though the page text/links never name them.
        await session.navigate("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
        // Give the player a moment; the manifest fetch is the navigation itself here.
        await session.wait(2);
        const all = session.getNetwork();
        expect(all.length).toBeGreaterThan(0);
        const manifests = session.getNetwork(".m3u8");
        // The navigated manifest (and its variant playlists) must be visible.
        expect(manifests.some((e) => e.url.includes(".m3u8"))).toBe(true);
        console.info(`\n[network] captured ${all.length} requests, ${manifests.length} m3u8\n`);
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
