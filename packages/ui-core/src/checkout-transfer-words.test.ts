import { expect, test } from "vitest";
import { CheckoutError } from "./checkout-errors.ts";
import {
  ArchivePreview,
  archiveFailure,
  archiveLeavesOut,
  archiveName,
  archiveSummary,
  keepBothPath,
} from "./checkout-transfer-words.ts";

test("an archive is named after its folder, or checkout at the root", () => {
  expect(archiveName("apps/web/")).toBe("web.tar.gz");
  expect(archiveName("")).toBe("checkout.tar.gz");
});

test("the preview says how much goes in and what stays out", () => {
  expect(archiveSummary({ entries: 1, bytes: 4_200_000 })).toBe(
    "1 entry · 4.2 MB before compression",
  );
  expect(archiveLeavesOut(false)).toMatch(/ignores/);
  expect(archiveLeavesOut(true)).not.toMatch(/ignores/);
});

test("a preview from a newer daemon keeps fields this client doesn't know", () => {
  const parsed = ArchivePreview.parse({ previewId: "p", entries: 2, bytes: 9, format: "tar.gz" });
  expect(parsed.format).toBe("tar.gz");
});

test("a stale preview says to choose the download again; other failures keep their sentence", () => {
  expect(archiveFailure(new CheckoutError("CONFLICT", "x")).message).toMatch(/Choose Download/);
  expect(archiveFailure(new CheckoutError("QUOTA", "Limit reached.")).message).toBe(
    "Limit reached.",
  );
});

test("keep both picks the first free numbered name beside the original", () => {
  const taken = new Set(["docs/notes.md", "docs/notes 2.md"]);
  expect(keepBothPath("docs/notes.md", (path) => taken.has(path))).toBe("docs/notes 3.md");
  expect(keepBothPath(".env", () => false)).toBe(".env 2");
  expect(keepBothPath("archive.tar.gz", () => false)).toBe("archive.tar 2.gz");
});
