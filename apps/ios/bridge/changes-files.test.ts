import { expect, test } from "vitest";
import { gitPatchFiles, PatchFileReader, type DiffRow } from "@ace/ui-core";
import type { MobileRow } from "@ace/ui-core/mobile";
import { TurnDiffs } from "./changes-diffs.ts";
import { OpenFiles, type DiffPage } from "./changes-files.ts";
import { plainPreview, RecordingSink, until } from "./sheet-fixture.ts";

/** A parser that counts the lines it is handed, so a test sees how much each page costs. */
class CountingReader extends PatchFileReader {
  lines = 0;
  override push(text: string): void {
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) this.lines++;
    super.push(text);
  }
}

/** A file's patch with several hunks, served in small pages cut mid-line and mid-hunk. */
function servedPatch() {
  const hunks = Array.from({ length: 60 }, (_, h) => {
    const start = h * 100 + 1;
    return [
      `@@ -${start},4 +${start},4 @@ hunk ${h}`,
      ` keep ${h}a`,
      `-old ${h} ${"x".repeat(h % 7)}`,
      `+new ${h} ${"y".repeat(h % 5)}`,
      ` keep ${h}b`,
      ` keep ${h}c`,
    ].join("\n");
  });
  const patch = [
    "diff --git a/src/long.ts b/src/long.ts",
    "--- a/src/long.ts",
    "+++ b/src/long.ts",
    ...hunks,
    "",
  ].join("\n");
  const size = 97;
  const pages: number[] = [];
  const readPage = async (_path: string, _from: string | null, offset: number) => {
    pages.push(offset);
    const end = Math.min(patch.length, offset + size);
    const page: DiffPage = {
      patch: patch.slice(offset, end),
      truncated: end < patch.length,
      validator: "v1",
      ...(end < patch.length ? { nextOffset: end } : {}),
    };
    return page;
  };
  return { patch, pages, readPage };
}

test("a cut file's pages parse once each into the rows a one-shot parse of the whole patch makes", async () => {
  const { patch, pages, readPage } = servedPatch();
  const readers: CountingReader[] = [];
  const sink = new RecordingSink();
  const files = new OpenFiles({
    sink,
    preview: plainPreview,
    threadId: "t",
    epoch: 1,
    diffs: new TurnDiffs(),
    readPage,
    layout: () => "unified",
    viewed: () => false,
    reader: () => {
      const reader = new CountingReader();
      readers.push(reader);
      return reader;
    },
    limits: { rows: 20, lineLength: 2000, runSlack: 5, open: 4, wholeLine: 1000, heldText: 1e6 },
  });
  const source = { kind: "daemon" as const, path: "src/long.ts", from: null, round: 1 };
  files.open("src/long.ts", { source, version: "" });
  const header = () => sink.read("changes:file:f00001");
  await until(() => header()?.state === "ready", "first page");
  for (let tries = 0; tries < 2000 && header()?.remaining !== 0; tries++) {
    files.more("src/long.ts");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const shown: MobileRow[] = [];
  for (let index = 0; ; index++) {
    const page = sink.read(`changes:page:f00001:${index}`);
    if (!page) break;
    shown.push(...(page.lines as MobileRow[]));
  }
  const whole: DiffRow[] = gitPatchFiles(patch)[0]?.rows ?? [];
  expect(pages.length).toBeGreaterThan(20);
  expect(
    shown.map(({ kind, old, new: next, text, count }) => ({ kind, old, next, text, count })),
  ).toEqual(
    whole.map((row) =>
      row.kind === "fold"
        ? { kind: "fold", old: null, next: null, text: "", count: row.count }
        : {
            kind: row.kind,
            old: row.old ?? null,
            next: row.new ?? null,
            text: row.text,
            count: null,
          },
    ),
  );
  // Every line of the patch went to the parser once, however many pages it came in.
  expect(readers).toHaveLength(1);
  expect(readers[0]?.lines).toBe(patch.split("\n").length - 1);
  expect(header()).toMatchObject({ version: "v1" });
});
