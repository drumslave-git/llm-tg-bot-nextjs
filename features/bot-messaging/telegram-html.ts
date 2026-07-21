/**
 * Model Markdown → Telegram HTML (user decision, 2026-07-20 — MVP parity in
 * effect, adapted in mechanism: the MVP prompted its model for HTML and
 * balanced it; ours emit standard Markdown, so this converts).
 *
 * Telegram's HTML parse mode accepts only a small tag set (<b> <i> <s> <u>
 * <code> <pre> <a> <blockquote> <tg-spoiler>) and requires every other `<`,
 * `>`, `&` to be entity-escaped, or the whole send is rejected. The rules here
 * are therefore conversion-by-construction: code spans are lifted out first,
 * everything else is escaped, and tags are only ever produced by paired regex
 * replacements — so the output cannot contain an unbalanced tag.
 *
 * Pure and dependency-free, applied at the transport boundary (the grammy
 * adapter), never earlier: history, traces, and the simulation harness all keep
 * the model's raw text. The transport falls back to a plain-text send if
 * Telegram still rejects the HTML.
 */

const PLACEHOLDER = "\u0000";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape an <a href> attribute value (quotes would end the attribute). */
function escapeAttr(url: string): string {
  return url.replace(/"/g, "%22");
}

/** Group consecutive escaped `> ` quote lines into one <blockquote>. */
function convertBlockquotes(lines: string[]): string[] {
  const out: string[] = [];
  let quote: string[] | null = null;
  const flush = () => {
    if (quote) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = null;
  };
  for (const line of lines) {
    const m = line.match(/^&gt;[ \t]?(.*)$/);
    if (m) {
      (quote ??= []).push(m[1]);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Render model Markdown as Telegram-safe HTML. Always returns balanced,
 * fully-escaped markup; input with no Markdown comes back as escaped text.
 */
export function renderTelegramHtml(markdown: string): string {
  // The placeholder char delimits lifted-out code spans below; model text
  // containing it would corrupt the restore, so it is dropped first.
  let s = markdown.replace(/\r\n/g, "\n").replaceAll(PLACEHOLDER, "");

  const lifted: string[] = [];
  const lift = (html: string): string => {
    lifted.push(html);
    return `${PLACEHOLDER}${lifted.length - 1}${PLACEHOLDER}`;
  };

  // Fenced code blocks first (their content is verbatim — no inline rules, no
  // escaping beyond entities). An unclosed fence runs to the end of the text.
  s = s.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    const cls = lang.trim() ? ` class="language-${lang.trim()}"` : "";
    return lift(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
  });

  // Inline code next, for the same reason.
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => lift(`<code>${escapeHtml(code)}</code>`));

  // Everything that remains is prose: escape it, then apply the inline rules —
  // every tag below is emitted by a paired replacement, so balance holds.
  s = escapeHtml(s);

  // Links before emphasis, so emphasis inside the label still converts.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<a href="${escapeAttr(url)}">${label}</a>`,
  );

  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // Single-marker emphasis needs word boundaries so snake_case identifiers and
  // 2*3*4-style arithmetic stay literal.
  s = s.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>");
  s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<i>$1</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

  // Line-level rules: headings become bold lines (Telegram has no headings),
  // bullets become the dot glyph, quote runs become one blockquote.
  const lines = s.split("\n").map((line) => {
    const heading = line.match(/^#{1,6}[ \t]+(.*)$/);
    if (heading) return `<b>${heading[1]}</b>`;
    return line.replace(/^([ \t]*)[-*][ \t]+/, "$1• ");
  });
  s = convertBlockquotes(lines).join("\n");

  s = s.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"), (_m, i: string) => lifted[Number(i)]);

  return s.replace(/\n{3,}/g, "\n\n").trim();
}
