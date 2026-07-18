import "server-only";

import type { Browser, BrowserContext } from "playwright";

import type { FetchedPage } from "../types";
import { hostResolvesPublic } from "./resolve-safety";

/**
 * Headless Chromium page reader for the read-link tool. The browser is expensive
 * to launch (~1s), so a single instance is kept alive on a `globalThis` singleton
 * — the same pattern the bot manager and MCP registry use — so it survives Next
 * bundle re-evaluation and dev hot-reload instead of leaking a Chromium process
 * per module copy. Each read gets its own short-lived context (isolated cookies,
 * fixed user-agent). When the browser agent feature (priority 13) lands it can
 * reuse this singleton rather than launch a second Chromium.
 *
 * `playwright` is loaded lazily (dynamic `import` inside {@link getSharedChromium})
 * rather than at module top level. It is a `serverExternalPackage`, so a static
 * import pulls the native package into the server boot graph (this module is
 * reachable from the instrumentation hook via the MCP registry) — and any problem
 * resolving it, e.g. a data file like `browsers.json` missing from the traced
 * standalone output, would then crash the whole app at startup. Loading it only
 * when a page is actually read keeps boot independent of the browser runtime and
 * confines any Chromium/provisioning failure to the read that needs it.
 */

const NAVIGATION_TIMEOUT_MS = 60_000;
const MAX_PAGE_TEXT_CHARS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; LLMTGBot/1.0; +https://github.com/drumslave-git/llm-tg-bot-nextjs)";

/**
 * Path to a system Chromium binary to launch instead of Playwright's own download.
 * Deploy-time bootstrap only: the Docker image runs on Alpine (musl), where
 * Playwright's bundled glibc Chromium won't run, so the runner installs the distro
 * `chromium` package and sets this to its path. Unset in dev — Playwright then uses
 * its downloaded browser as usual.
 */
const CHROMIUM_EXECUTABLE_PATH = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;

interface BrowserStore {
  browser: Browser | null;
  launching: Promise<Browser> | null;
}

const STORE_KEY = Symbol.for("llm-tg-bot.link-fetch.chromium");

function store(): BrowserStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: BrowserStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { browser: null, launching: null };
  return g[STORE_KEY];
}

/**
 * The shared headless Chromium instance, launched on first use. Idempotent and
 * safe under concurrency — the first caller launches, the rest await the same
 * promise. A failed launch clears the promise so a later call can retry.
 */
export async function getSharedChromium(): Promise<Browser> {
  const s = store();
  if (s.browser?.isConnected()) return s.browser;
  if (!s.launching) {
    s.launching = import("playwright")
      .then(({ chromium }) =>
        chromium.launch({
          headless: true,
          executablePath: CHROMIUM_EXECUTABLE_PATH,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        }),
      )
      .then((b) => {
        s.browser = b;
        return b;
      })
      .catch((err) => {
        s.launching = null;
        throw err;
      });
  }
  return s.launching;
}

/** Close the shared browser (for tests/shutdown); a later read relaunches it. */
export async function closeSharedChromium(): Promise<void> {
  const s = store();
  if (s.browser) {
    await s.browser.close().catch(() => {});
  }
  s.browser = null;
  s.launching = null;
}

/** Collapse whitespace and bound the length of extracted page text. */
function trimPageText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_CHARS);
}

/**
 * Read one page's title + readable text with headless Chromium. Never throws:
 * a navigation/render failure resolves to a `FetchedPage` carrying the `error`,
 * so the tool boundary can always hand the model a usable result.
 */
export async function fetchPageWithPlaywright(url: string): Promise<FetchedPage> {
  let context: BrowserContext | null = null;
  // One DNS verdict per hostname per page load — shared by the pre-navigation
  // check and the request interception below.
  const dnsVerdicts = new Map<string, boolean>();
  let blockedPrivate = false;
  try {
    // The URL-shape guard ran at the tool boundary; this is the DNS half — a
    // public-looking hostname may still resolve into the private network.
    if (!(await hostResolvesPublic(new URL(url).hostname, dnsVerdicts))) {
      return {
        url,
        title: "",
        text: "",
        error: "URL blocked for safety (hostname resolves to a private network address)",
      };
    }

    const browser = await getSharedChromium();
    context = await browser.newContext({ userAgent: USER_AGENT });
    // Every request — redirect hops and subresources included — is re-checked,
    // so a public page cannot bounce or embed its way to an internal address.
    await context.route("**/*", async (route) => {
      let allowed = false;
      try {
        const target = new URL(route.request().url());
        allowed =
          target.protocol !== "http:" && target.protocol !== "https:"
            ? true // non-network scheme (data:, blob:) — nothing to reach
            : await hostResolvesPublic(target.hostname, dnsVerdicts);
      } catch {
        allowed = false; // unparseable URL — cannot verify, so do not fetch
      }
      if (allowed) return route.continue();
      // Only a blocked *navigation* (the initial load or a redirect hop) fails
      // the read; a blocked subresource just doesn't load.
      if (route.request().isNavigationRequest()) blockedPrivate = true;
      return route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      const title = (await page.title()).trim();
      const rawText = await page.evaluate(() => document.body?.innerText ?? "");
      return { url, title, text: trimPageText(rawText) };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    // A navigation the interception aborted surfaces as a cryptic
    // net::ERR_BLOCKED_BY_CLIENT — name the real reason instead.
    if (blockedPrivate) {
      return {
        url,
        title: "",
        text: "",
        error: "URL blocked for safety (redirects to a private network address)",
      };
    }
    return { url, title: "", text: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
