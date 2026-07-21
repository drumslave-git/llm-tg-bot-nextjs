import { describe, expect, it } from "vitest";

import { renderTelegramHtml } from "./telegram-html";

describe("renderTelegramHtml", () => {
  it("escapes plain text with HTML-significant characters", () => {
    expect(renderTelegramHtml("a < b && b > c")).toBe("a &lt; b &amp;&amp; b &gt; c");
  });

  it("converts bold, italic and strikethrough", () => {
    expect(renderTelegramHtml("**bold** and *it* and ~~gone~~")).toBe(
      "<b>bold</b> and <i>it</i> and <s>gone</s>",
    );
    expect(renderTelegramHtml("__bold__ and _it_")).toBe("<b>bold</b> and <i>it</i>");
  });

  it("leaves snake_case and star arithmetic literal", () => {
    expect(renderTelegramHtml("use known_users.first_seen_at")).toBe(
      "use known_users.first_seen_at",
    );
    expect(renderTelegramHtml("2*3*4 = 24")).toBe("2*3*4 = 24");
  });

  it("renders inline code with its content escaped, not formatted", () => {
    expect(renderTelegramHtml("run `a < b && **x**` now")).toBe(
      "run <code>a &lt; b &amp;&amp; **x**</code> now",
    );
  });

  it("renders fenced code blocks with a language class", () => {
    expect(renderTelegramHtml('```ts\nconst a = "<x>";\n```')).toBe(
      '<pre><code class="language-ts">const a = "&lt;x&gt;";</code></pre>',
    );
    expect(renderTelegramHtml("```\nplain\n```")).toBe("<pre><code>plain</code></pre>");
  });

  it("closes an unterminated fence at the end of the text", () => {
    expect(renderTelegramHtml("```\nno closing")).toBe("<pre><code>no closing</code></pre>");
  });

  it("converts links and keeps non-http schemes literal", () => {
    expect(renderTelegramHtml("see [docs](https://example.com/a?b=1&c=2)")).toBe(
      'see <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    );
    expect(renderTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });

  it("turns headings into bold lines and bullets into dots", () => {
    expect(renderTelegramHtml("# Title\n- one\n* two")).toBe("<b>Title</b>\n• one\n• two");
  });

  it("groups consecutive quote lines into one blockquote", () => {
    expect(renderTelegramHtml("> first\n> second\nafter")).toBe(
      "<blockquote>first\nsecond</blockquote>\nafter",
    );
  });

  it("collapses runs of blank lines and trims", () => {
    expect(renderTelegramHtml("a\n\n\n\nb  ")).toBe("a\n\nb");
  });

  it("returns markup with every produced tag balanced", () => {
    const html = renderTelegramHtml(
      "# H\n**b** *i* `c` ~~s~~ [l](https://e.com)\n```js\nx\n```\n> q",
    );
    for (const tag of ["b", "i", "code", "s", "a", "pre", "blockquote"]) {
      const opens = html.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0;
      const closes = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(opens, tag).toBe(closes);
    }
  });
});
