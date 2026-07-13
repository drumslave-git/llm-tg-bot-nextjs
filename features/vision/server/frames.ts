import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Video/GIF frame sampling for vision. Telegram delivers gifs and videos as mp4,
 * which sharp cannot decode, so frames are pulled with the system `ffmpeg` binary
 * (user decision — system ffmpeg over a bundled/WASM build; see Decision Notes).
 * Always {@link VIDEO_FRAME_COUNT} frames are sampled **evenly across the whole
 * clip** (ffmpeg `fps=count/duration`), so short and long clips alike are covered
 * end to end — never just the opening frames. The caller sends them to the model
 * as an ordered image sequence (see `format.frameSequenceHint`/`toVisionParts`).
 */

/** Frames sampled from every clip, evenly spread across its full length. */
export const VIDEO_FRAME_COUNT = 10;
/** Kill a stuck ffmpeg/ffprobe run rather than hang the reply. */
const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;

/** Run ffmpeg to completion, rejecting on non-zero exit, spawn error, or timeout. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** Probe a media file's duration (seconds) with ffprobe, or null if unavailable. */
function probeDurationSec(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, FFPROBE_TIMEOUT_MS);
    proc.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const n = Number.parseFloat(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

/**
 * Sample up to `count` JPEG frames evenly across a clip. Writes the input to a
 * temp dir, runs ffmpeg, reads the frames back, and always cleans up. The
 * duration drives even spacing (`fps = count/duration`); when it is not supplied
 * (e.g. a video sent as a document) it is probed with ffprobe so frames still
 * span the whole clip rather than clustering at the start. Throws if ffmpeg is
 * unavailable or fails (the caller falls back to the thumbnail).
 */
export async function extractVideoFrames(
  input: Buffer,
  opts: { count: number; durationSec: number | null },
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), "vision-frames-"));
  try {
    const inputPath = join(dir, "input");
    await writeFile(inputPath, input);

    let duration = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : null;
    if (!duration) duration = await probeDurationSec(inputPath);

    const args = ["-hide_banner", "-loglevel", "error", "-i", inputPath];
    // Spread `count` frames evenly across the known duration; without a duration
    // fall back to the leading frames (better than nothing).
    if (opts.count > 1 && duration && duration > 0) {
      const fps = opts.count / duration;
      args.push("-vf", `fps=${fps.toFixed(6)}`);
    }
    args.push("-frames:v", String(opts.count), "-q:v", "3", join(dir, "frame_%03d.jpg"));
    await runFfmpeg(args);

    const files = (await readdir(dir)).filter((f) => f.startsWith("frame_")).sort();
    const frames: Buffer[] = [];
    for (const file of files) frames.push(await readFile(join(dir, file)));
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
