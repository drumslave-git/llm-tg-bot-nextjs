import "server-only";

import { readFile } from "node:fs/promises";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import type { McpToolCallResult } from "@/server/mcp/tool-result";

import { formatSnapshot, type PageSnapshot } from "../snapshot";
import type { BrowserDownloadRecord } from "../types";
import { downloadToDisk } from "./download";
import type { BrowserAgentSession } from "./session";

/**
 * The browser agent's generic toolset (recorded decision: no scenario-specific
 * tools — navigate/back/click/type/scroll/read/source/screenshot/wait/download
 * cover a variety of tasks instead of encoding any one of them). These are plain
 * OpenAI tool definitions for the agent's own tool loop — they are NOT MCP tools
 * and are never offered to the main chat model; only the `browse_web` dispatch
 * tool is (see `mcp-tools.ts`).
 */

/** A file collected during a run, delivered to the chat as it lands. */
export interface CollectedFile {
  buffer: Buffer;
  filename: string;
  mime: string;
}

/** Collaborators one run's dispatcher acts through. */
export interface AgentToolContext {
  session: BrowserAgentSession;
  /** Whether the run was started by the owner — gates browser_download. */
  isOwner: boolean;
  /** Largest file (MB) that is also attached to the chat. */
  downloadMaxMb: number;
  /** Every completed download, for the run row + end-of-run recap. */
  downloads: BrowserDownloadRecord[];
  /** Called before each action, with a short label + the current URL. */
  onAction: (action: string, url: string | null) => void | Promise<void>;
  /**
   * Store one captured screenshot (bytes never travel through the trace).
   * Resolves the stored sequence number, for the result text.
   */
  onScreenshot: (shot: { buffer: Buffer; url: string | null; title: string | null }) => Promise<number>;
  /**
   * Report ONE finished download to the chat immediately — a small file as an
   * attachment, a large one as a text line — so the user sees every file arrive
   * instead of a batch at the end of the run.
   */
  onDownload: (record: BrowserDownloadRecord, file: CollectedFile | null) => Promise<void>;
}

function fn(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

/** OpenAI tool definitions for the browser agent loop. */
export const BROWSER_AGENT_TOOLS: ChatCompletionFunctionTool[] = [
  fn(
    "browser_navigate",
    "Open a URL in the browser and return the page's text and interactive elements. Start here.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to open" },
      },
      required: ["url"],
    },
  ),
  fn(
    "browser_back",
    "Go back one step in the browser history. Returns the new page state.",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_click",
    "Click an interactive element by its ref number (from the last page state's INTERACTIVE ELEMENTS list). Returns the new page state.",
    {
      type: "object",
      properties: {
        ref: { type: "number", description: "The [N] ref of the element to click" },
      },
      required: ["ref"],
    },
  ),
  fn(
    "browser_type",
    "Type text into an input/textarea by its ref number, optionally submitting (Enter). Returns the new page state.",
    {
      type: "object",
      properties: {
        ref: { type: "number", description: "The [N] ref of the input element" },
        text: { type: "string", description: "Text to type" },
        submit: {
          type: "boolean",
          description: "Press Enter after typing (e.g. to run a search)",
        },
      },
      required: ["ref", "text"],
    },
  ),
  fn(
    "browser_scroll",
    "Scroll the page up or down by one or more screens, to reach content below the fold. Returns the new page state.",
    {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
        pages: { type: "number", description: "How many screens to scroll (default 1)" },
      },
      required: ["direction"],
    },
  ),
  fn(
    "browser_read",
    "Re-read the current page (after it changed). Returns text + elements.",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_source",
    "Read the current page's raw HTML source, in bounded chunks. Use when the visible text is not enough (hidden data, script-embedded values, exact markup); pass a larger offset to read further into the document.",
    {
      type: "object",
      properties: {
        offset: { type: "number", description: "Character offset to start from (default 0)" },
      },
    },
  ),
  fn(
    "browser_screenshot",
    "Capture a screenshot of the current page. The image is shown to you so you can see the page visually — use it when the text snapshot is not enough (layouts, images, charts, rendering issues).",
    { type: "object", properties: {} },
  ),
  fn(
    "browser_wait",
    "Wait for a slow page to finish loading or updating (bounded seconds), then return the fresh page state.",
    {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long to wait (1–30 seconds)" },
      },
      required: ["seconds"],
    },
  ),
  fn(
    "browser_download",
    "Download a file from a URL to the server's downloads folder (only available when the run was started by the owner). The file is named automatically from the current page's title — do NOT pass a filename. Small files are also attached to the chat; large ones are reported by name.",
    {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL of the file" },
      },
      required: ["url"],
    },
  ),
];

function snapshotResult(snapshot: PageSnapshot): McpToolCallResult {
  return { text: formatSnapshot(snapshot) };
}

function errorResult(message: string): McpToolCallResult {
  return { text: `Error: ${message}`, isError: true };
}

function num(args: Record<string, unknown>, key: string): number | null {
  const v = args[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Build the dispatcher the agent's tool loop calls for each browser action. */
export function makeBrowserToolDispatcher(ctx: AgentToolContext) {
  return async (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
    try {
      switch (name) {
        case "browser_navigate": {
          const url = str(args, "url");
          await ctx.onAction(`navigate ${url}`, ctx.session.currentUrl());
          return snapshotResult(await ctx.session.navigate(url));
        }
        case "browser_back": {
          await ctx.onAction("back", ctx.session.currentUrl());
          return snapshotResult(await ctx.session.back());
        }
        case "browser_click": {
          const ref = num(args, "ref");
          if (ref == null) return errorResult("ref is required");
          await ctx.onAction(`click [${ref}]`, ctx.session.currentUrl());
          return snapshotResult(await ctx.session.click(ref));
        }
        case "browser_type": {
          const ref = num(args, "ref");
          if (ref == null) return errorResult("ref is required");
          const text = str(args, "text");
          const submit = args.submit === true;
          await ctx.onAction(`type into [${ref}]`, ctx.session.currentUrl());
          return snapshotResult(await ctx.session.type(ref, text, submit));
        }
        case "browser_scroll": {
          const direction = str(args, "direction") === "up" ? "up" : "down";
          const pages = num(args, "pages") ?? 1;
          await ctx.onAction(`scroll ${direction}`, ctx.session.currentUrl());
          return snapshotResult(await ctx.session.scroll(direction, pages));
        }
        case "browser_read": {
          await ctx.onAction("read page", ctx.session.currentUrl());
          return snapshotResult(await ctx.session.read());
        }
        case "browser_source": {
          const offset = num(args, "offset") ?? 0;
          await ctx.onAction(`read source @${offset}`, ctx.session.currentUrl());
          const { html, offset: start, total } = await ctx.session.source(offset);
          const end = start + html.length;
          const header =
            `PAGE SOURCE (characters ${start}–${end} of ${total}` +
            (end < total ? `; call again with offset ${end} for more` : "; end of document") +
            `):\n`;
          return { text: header + html };
        }
        case "browser_screenshot": {
          await ctx.onAction("screenshot", ctx.session.currentUrl());
          const buffer = await ctx.session.screenshot();
          const meta = await ctx.session.pageMeta();
          const seq = await ctx.onScreenshot({ buffer, url: meta.url, title: meta.title });
          return {
            text: `Screenshot #${seq + 1} captured (shown to you as an image).`,
            images: [`data:image/jpeg;base64,${buffer.toString("base64")}`],
          };
        }
        case "browser_wait": {
          const seconds = num(args, "seconds") ?? 3;
          await ctx.onAction(`wait ${seconds}s`, ctx.session.currentUrl());
          return snapshotResult(await ctx.session.wait(seconds));
        }
        case "browser_download": {
          if (!ctx.isOwner) {
            return errorResult(
              "Downloads are disabled for this run (only the owner can download files).",
            );
          }
          const url = str(args, "url");
          await ctx.onAction(`download ${url}`, ctx.session.currentUrl());
          // Name the file (and record its source) from the page it came from —
          // never from a model-supplied name, which is inconsistent.
          const meta = await ctx.session.pageMeta();
          const result = await downloadToDisk(url, { title: meta.title });
          const mb = Math.round(result.sizeBytes / 1024 / 1024);
          // Small enough for Telegram — also attach it to the chat.
          const inline = result.sizeBytes <= ctx.downloadMaxMb * 1024 * 1024;
          const record: BrowserDownloadRecord = {
            sourceUrl: meta.url ?? url,
            filename: result.filename,
            sizeBytes: result.sizeBytes,
            inline,
          };
          ctx.downloads.push(record);
          const file: CollectedFile | null = inline
            ? { buffer: await readFile(result.filePath), filename: result.filename, mime: result.mime }
            : null;
          await ctx.onDownload(record, file);
          return {
            text:
              `Saved to the downloads folder as "${result.filename}" (${mb} MB).` +
              (inline
                ? " Attaching it to the chat now."
                : " It is too large to attach here — tell the user the filename and that it is in the downloads folder. Do NOT paste a URL."),
          };
        }
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : "Tool failed");
    }
  };
}
