import "server-only";

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isSafePublicUrl, normalizeUrl } from "@/features/link-fetch/url-safety";
import { hostResolvesPublic } from "@/features/link-fetch/server/resolve-safety";

import { buildDownloadFilename } from "../files";

/**
 * Generic file download for the browser agent: stream a public URL to the
 * project's downloads folder, SSRF-checked at every redirect hop, with a size
 * cap. This is the plain-HTTP primitive (`browser_download_file`); the HLS/DASH
 * stream primitive (`browser_download_stream`) lives in `stream-download.ts` and
 * reuses the SSRF/naming helpers exported here. Neither encodes *which* file to
 * fetch — the agent finds the URL (via the page or the network) and picks the
 * matching tool.
 */

/**
 * Project-root downloads folder (Docker-mountable). `DOWNLOADS_DIR` env is a
 * deploy-time bootstrap override (like `DATABASE_URL`), not runtime config.
 */
export const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");

/** A file streamed to the downloads folder. */
export interface DiskDownload {
  filePath: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

const MAX_REDIRECTS = 5;
const HEADER_TIMEOUT_MS = 60_000;
/** Safety cap so a runaway response can't fill the disk. */
const MAX_DISK_BYTES = 2 * 1024 * 1024 * 1024;

/** Browser-like headers: plenty of file hosts refuse a bare fetch. Shared with the stream downloader. */
export const DOWNLOAD_HEADERS = (url: URL): Record<string, string> => ({
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  referer: url.origin + "/",
  accept: "*/*",
});

/**
 * Full SSRF check for a URL about to be fetched server-side: shape (scheme,
 * no credentials, public-looking host) plus DNS (the host must resolve to a
 * public address). Throws with a safety message on any failure. Exported so the
 * stream downloader guards its manifest + segment URLs the same way.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized || !isSafePublicUrl(normalized)) {
    throw new Error("URL blocked for safety (private network or unsupported scheme)");
  }
  const url = new URL(normalized);
  if (!(await hostResolvesPublic(url.hostname, new Map()))) {
    throw new Error("URL blocked for safety (hostname resolves to a private network address)");
  }
  return url;
}

/** Follow redirects manually so every hop is SSRF-checked before it is fetched. */
async function resolveFinalResponse(
  rawUrl: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: DOWNLOAD_HEADERS(current),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { response, finalUrl: current };
        await response.body?.cancel().catch(() => {});
        current = await assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      return { response, finalUrl: current };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects fetching ${rawUrl}`);
}

/** Pick a non-colliding filename in the downloads dir (adds " (n)" if needed). Shared. */
export async function uniqueFilename(filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  for (;;) {
    try {
      await fs.access(path.join(DOWNLOADS_DIR, candidate));
      candidate = `${stem} (${n})${ext}`;
      n += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * Download a URL to the downloads folder, naming the file from the page title.
 * Streams to disk (a large file never sits in memory) with the size cap; a
 * failed/oversized transfer removes the partial file and throws.
 */
export async function downloadToDisk(
  rawUrl: string,
  options: { title?: string | null } = {},
): Promise<DiskDownload> {
  const { response, finalUrl } = await resolveFinalResponse(rawUrl);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Download failed: empty response body");

  const mime = (response.headers.get("content-type") ?? "application/octet-stream")
    .split(";")[0]
    .trim();

  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });
  const filename = await uniqueFilename(
    buildDownloadFilename(options.title, finalUrl.toString(), mime),
  );
  const filePath = path.join(DOWNLOADS_DIR, filename);

  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > MAX_DISK_BYTES) {
        cb(new Error(`Download exceeds the ${Math.round(MAX_DISK_BYTES / 1024 / 1024)} MB cap`));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(filePath),
    );
  } catch (err) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw err;
  }

  return { filePath, filename, mime, sizeBytes: written };
}
