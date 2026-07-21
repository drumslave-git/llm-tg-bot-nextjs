/**
 * Page snapshot contract for the browser agent: the readable text of the current
 * page plus a numbered list of its interactive elements. The agent acts by ref —
 * "click [12]", "type into [3]" — and every action returns a fresh snapshot so
 * refs always match the live DOM.
 *
 * Pure (no Playwright import): the in-page script is built here as a string and
 * evaluated by the server session, so formatting and the script builder are
 * unit-testable without a browser. Grounded in the MVP `web-browse/snapshot.ts`.
 */

export const MAX_SNAPSHOT_TEXT_CHARS = 8_000;
export const MAX_SNAPSHOT_ELEMENTS = 80;

/** Attribute name used to bind numbered refs to DOM elements between calls. */
export const REF_ATTR = "data-agent-ref";

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  /** Absolute destination for links (empty for non-links). */
  href: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
}

/**
 * In-page snapshot code as a STRING passed verbatim to `page.evaluate`. Passing
 * a function would be re-serialized via `Function.prototype.toString` after the
 * build rewrites nested helpers with `__name(...)` wrappers that don't exist in
 * the browser — throwing `ReferenceError: __name is not defined`. A string is
 * evaluated as-is, immune to the build transform.
 */
export function buildSnapshotScript(attr: string, limit: number): string {
  return `(() => {
    var attr = ${JSON.stringify(attr)};
    var limit = ${Number(limit)};
    var selector = "a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary, [contenteditable=true]";
    function isVisible(el) {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      var style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    function accessibleName(el) {
      var aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      var placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      var value = el.value;
      if (typeof value === "string" && value.trim()) return value.trim();
      var text = (el.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text;
      var titleAttr = el.getAttribute("title");
      return titleAttr && titleAttr.trim() ? titleAttr.trim() : "";
    }
    function roleOf(el) {
      var explicit = el.getAttribute("role");
      if (explicit && explicit.trim()) return explicit.trim();
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "input") return (el.getAttribute("type") || "text").toLowerCase();
      return tag;
    }
    var prior = document.querySelectorAll("[" + attr + "]");
    for (var i = 0; i < prior.length; i++) prior[i].removeAttribute(attr);
    var out = [];
    var ref = 0;
    var nodes = document.querySelectorAll(selector);
    for (var j = 0; j < nodes.length; j++) {
      if (out.length >= limit) break;
      var el = nodes[j];
      if (!isVisible(el)) continue;
      ref += 1;
      el.setAttribute(attr, String(ref));
      var href = el.tagName === "A" && el.href ? String(el.href).slice(0, 300) : "";
      out.push({ ref: ref, role: roleOf(el), name: accessibleName(el).slice(0, 120), href: href });
    }
    var body = document.body ? document.body.innerText : "";
    return { text: body || "", elements: out };
  })()`;
}

/** Render a snapshot as the text the agent reads to decide its next action. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || "(untitled)"}`,
    "",
    "PAGE TEXT:",
    snapshot.text || "(no visible text)",
  ];
  if (snapshot.elements.length > 0) {
    lines.push("", "INTERACTIVE ELEMENTS (use the number as ref):");
    for (const el of snapshot.elements) {
      const dest = el.href ? ` -> ${el.href}` : "";
      lines.push(`[${el.ref}] ${el.role}${el.name ? ` "${el.name}"` : ""}${dest}`);
    }
  } else {
    lines.push("", "INTERACTIVE ELEMENTS: (none detected)");
  }
  return lines.join("\n");
}
