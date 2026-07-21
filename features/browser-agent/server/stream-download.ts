import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { selectBestHlsInputs } from "../hls";
import { buildDownloadFilename } from "../files";
import {
  assertPublicUrl,
  DOWNLOAD_HEADERS,
  DOWNLOADS_DIR,
  uniqueFilename,
  type DiskDownload,
} from "./download";

/**
 * Generic stream-download primitive (`browser_download_stream`): given an
 * HLS/DASH **manifest** URL the agent found (in the page or the network traffic),
 * mux it into a single MP4 with ffmpeg. The agent decides *what* to download and
 * supplies the URL; this only knows how to turn a manifest into a file. SSRF-
 * guarded on the manifest and every redirect ffmpeg would follow is out of our
 * hands, so the manifest itself is checked and only public hosts are handed to
 * ffmpeg.
 */

/** Thrown when a stream needs ffmpeg but it is not installed. */
export class FfmpegMissingError extends Error {}

/** ffmpeg read/write timeout (µs) so a stalled segment can't hang forever. */
const STREAM_RW_TIMEOUT_US = 30_000_000;
/** Absolute cap on the muxed output (leaves a valid, playable partial for long videos). */
const MAX_STREAM_BYTES = 4 * 1024 * 1024 * 1024;

/** Fetch an HLS master and resolve it to the best-quality ffmpeg input(s). */
async function resolveHlsInputs(url: URL): Promise<{ inputUrls: string[]; maps: string[] }> {
  const asIs = { inputUrls: [url.toString()], maps: [] as string[] };
  if (!/\.m3u8(\/|\?|$)/i.test(url.pathname)) return asIs; // DASH/other → hand to ffmpeg as-is
  try {
    const res = await fetch(url.toString(), { headers: DOWNLOAD_HEADERS(url), redirect: "follow" });
    if (!res.ok) return asIs;
    return selectBestHlsInputs(await res.text(), url.toString());
  } catch {
    return asIs;
  }
}

/**
 * Download an HLS/DASH stream (`.m3u8`/`.mpd`) by muxing its segments into one
 * `.mp4` with ffmpeg (`-c copy`, no re-encode) — blob/MSE players feed segments
 * into the page, so there is no single progressive file to GET. Uses the system
 * ffmpeg; throws {@link FfmpegMissingError} when it is absent. The `-fs` cap stops
 * it at the size limit, leaving a valid partial. Never re-encodes.
 */
export async function downloadStreamToDisk(
  rawUrl: string,
  options: { title?: string | null } = {},
): Promise<DiskDownload> {
  const url = await assertPublicUrl(rawUrl);
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  // The mux always yields an MP4 regardless of the .m3u8/.mpd source extension.
  const base = buildDownloadFilename(options.title, url.toString(), "video/mp4");
  const filename = await uniqueFilename(`${base.replace(/\.[a-z0-9]{1,5}$/i, "")}.mp4`);
  const filePath = path.join(DOWNLOADS_DIR, filename);

  const headerArg =
    Object.entries(DOWNLOAD_HEADERS(url))
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n") + "\r\n";

  // Resolve to the highest-quality inputs (top-bandwidth video + its demuxed
  // audio for an HLS master); otherwise ffmpeg is handed the URL as-is.
  const { inputUrls, maps } = await resolveHlsInputs(url);

  const inputArgs = inputUrls.flatMap((inUrl) => [
    "-rw_timeout",
    String(STREAM_RW_TIMEOUT_US),
    // Accept real segments whose URL extension is non-standard (some CDNs name TS
    // segments `.png`/`.image`); ffmpeg otherwise refuses them.
    "-extension_picky",
    "0",
    "-headers",
    headerArg,
    "-i",
    inUrl,
  ]);
  const outArgs = (bsf: string[]): string[] => [
    ...maps,
    "-c",
    "copy",
    ...bsf,
    "-fs",
    String(MAX_STREAM_BYTES),
    filePath,
  ];

  // TS-packaged AAC needs the aac_adtstoasc bitstream filter to become valid in an
  // MP4 — but that same filter errors on fMP4 (already-ASC) HLS. Try with it first
  // (older TS-based streams), then fall back without it (modern fMP4), so one code
  // path covers both segment formats.
  const sizeBytes = await runFfmpeg(
    ["-y", ...inputArgs, ...outArgs(["-bsf:a", "aac_adtstoasc"])],
    filePath,
  ).catch(async (err: unknown) => {
    if (err instanceof FfmpegMissingError) throw err;
    return runFfmpeg(["-y", ...inputArgs, ...outArgs([])], filePath);
  });

  if (sizeBytes === 0) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw new Error("Streaming download failed: ffmpeg produced no output.");
  }
  return { filePath, filename, mime: "video/mp4", sizeBytes };
}

/**
 * Run ffmpeg and return the output file's byte size. Throws {@link FfmpegMissingError}
 * when ffmpeg is absent; throws (file removed) when the run produced nothing.
 * ffmpeg exits non-zero when the `-fs` cap interrupts it, yet the partial MP4 is
 * valid, so a non-empty file counts as success regardless of exit code.
 */
async function runFfmpeg(args: string[], filePath: string): Promise<number> {
  let stderrTail = "";
  const outcome = await new Promise<number | "enoent">((resolve) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-2000);
    });
    proc.on("error", () => resolve("enoent")); // ffmpeg not installed
    proc.on("close", (code) => resolve(code ?? 1));
  });

  if (outcome === "enoent") {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw new FfmpegMissingError(
      "This is a streaming (HLS/DASH) video, which needs ffmpeg to assemble into a file, but ffmpeg is not installed on the server.",
    );
  }

  let sizeBytes = 0;
  try {
    sizeBytes = (await fs.stat(filePath)).size;
  } catch {
    sizeBytes = 0;
  }
  if (sizeBytes === 0) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    const reason = stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
    throw new Error(`ffmpeg exited ${outcome} with no output${reason ? `: ${reason}` : ""}`);
  }
  return sizeBytes;
}
