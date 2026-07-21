import { describe, expect, it } from "vitest";

import { buildDownloadFilename, extForUrl, primaryTitle, safeFilename } from "./files";

/**
 * Filenames come from untrusted page titles and URLs, so these assertions cover
 * the two failure modes that matter: a name that is unsafe on disk, and a name
 * with no meaningful extension.
 */

describe("safeFilename", () => {
  it("strips path separators and reserved characters", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename('a<b>c:"d"|e?f*g')).toBe("abcdefg");
  });

  it("falls back for an empty or dot-only name", () => {
    expect(safeFilename("")).toBe("download.bin");
    expect(safeFilename("..")).toBe("download.bin");
  });

  it("keeps unicode letters", () => {
    expect(safeFilename("Отчёт")).toBe("Отчёт");
  });
});

describe("extForUrl", () => {
  it("prefers the URL path extension", () => {
    expect(extForUrl("https://x.com/report.pdf?token=1", "application/octet-stream")).toBe("pdf");
  });

  it("falls back to the content type when the path has none", () => {
    expect(extForUrl("https://x.com/download", "application/pdf")).toBe("pdf");
    expect(extForUrl("https://x.com/file", "image/png")).toBe("png");
  });

  it("returns bin when nothing is known", () => {
    expect(extForUrl("https://x.com/thing", "application/x-unknown")).toBe("bin");
  });
});

describe("primaryTitle", () => {
  it("takes the segment before a site-name separator", () => {
    expect(primaryTitle("Annual Report — Acme Inc")).toBe("Annual Report");
    expect(primaryTitle("Widget | Store")).toBe("Widget");
  });

  it("keeps a short title with no separator whole", () => {
    expect(primaryTitle("Home")).toBe("Home");
  });
});

describe("buildDownloadFilename", () => {
  it("names the file from the title plus the URL extension", () => {
    expect(buildDownloadFilename("Q3 Report — Acme", "https://x.com/dl/123.pdf", "application/pdf")).toBe(
      "Q3 Report.pdf",
    );
  });

  it("falls back to the URL basename when there is no title", () => {
    expect(buildDownloadFilename(null, "https://x.com/files/data.csv", "text/csv")).toBe("data.csv");
  });
});
