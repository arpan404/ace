import { afterEach, describe, expect, test } from "vitest";
import type { ChangesStep, MobileRow } from "@ace/ui-core/mobile";
import { fileHeader, filePages, openChanges } from "./changes-fixture.ts";
import { gitAction } from "./git-actions.ts";
import { plainPreview, until, type RecordingSink } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const big = Array.from({ length: 3000 }, (_, index) => `+line ${index + 1}`).join("\n");
const patch = [
  "diff --git a/src/small.ts b/src/small.ts",
  "index 1111111..2222222 100644",
  "--- a/src/small.ts",
  "+++ b/src/small.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  ` ${"x".repeat(5000)}`,
  "diff --git a/src/big.ts b/src/big.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/big.ts",
  "@@ -0,0 +1,3000 @@",
  big,
  "",
].join("\n");
const status = [
  { path: "src/small.ts", status: "modified" as const, additions: 1, deletions: 1, binary: false },
  { path: "src/big.ts", status: "added" as const, additions: 3000, deletions: 0, binary: false },
];

async function opened(options: { patch?: string; status?: typeof status } = {}) {
  const sheet = await openChanges({
    turns: false,
    patch: options.patch ?? patch,
    status: options.status ?? status,
  });
  closers.push(sheet.close);
  return sheet;
}
const step = (sink: RecordingSink) => sink.read("changes:summary")?.step as ChangesStep;
const rows = (sink: RecordingSink, path: string) =>
  filePages(sink, path).flatMap((page) => page.lines as MobileRow[]);

describe("Changes sheet", () => {
  test("files carry their counts and the totals add up", async () => {
    const { sink } = await opened();
    const summary = sink.read("changes:summary");
    expect(summary?.files).toEqual([
      expect.objectContaining({ path: "src/big.ts", status: "added", additions: 3000 }),
      expect.objectContaining({ path: "src/small.ts", additions: 1, deletions: 1, viewed: false }),
    ]);
    expect(summary?.totals).toEqual({ files: 2, additions: 3001, deletions: 1 });
    expect(summary?.scope).toMatchObject({ id: "working-tree", label: "Uncommitted" });
    expect(step(sink)).toMatchObject({ kind: "commit", label: "Commit & push", blocked: null });
  });

  test("a large file arrives a page at a time and every line is reachable", async () => {
    const { session, sink } = await opened();
    session.file("src/big.ts");
    expect(filePages(sink, "src/big.ts")).toHaveLength(1);
    // 300 rows, and a run of changes the cut fell in finished within 200 more.
    const first = rows(sink, "src/big.ts").length;
    expect(first).toBeGreaterThanOrEqual(300);
    expect(first).toBeLessThanOrEqual(500);
    expect(fileHeader(sink, "src/big.ts")).toMatchObject({
      complete: true,
      remaining: 3000 - first,
    });
    while (Number(fileHeader(sink, "src/big.ts")?.remaining) > 0) session.more("src/big.ts");
    const all = rows(sink, "src/big.ts");
    expect(all).toHaveLength(3000);
    expect(all[0]).toMatchObject({ kind: "add", new: 1, text: "line 1" });
    expect(all.at(-1)).toMatchObject({ kind: "add", new: 3000, text: "line 3000" });
  });

  test("a long line is clipped in its page and sent whole when asked for", async () => {
    const { session, sink } = await opened();
    session.file("src/small.ts");
    const shown = rows(sink, "src/small.ts");
    expect(shown.map((line) => [line.kind, line.old, line.new])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["context", 3, 3],
    ]);
    const long = shown.at(-1);
    expect(long).toMatchObject({ clipped: true, length: 5000 });
    expect(long?.text).toHaveLength(2000);
    session.line("src/small.ts", long?.i ?? -1);
    expect(sink.read("changes:line")?.row).toMatchObject({
      clipped: false,
      text: "x".repeat(5000),
    });
  });

  test("split layout pairs a removed line with the line that replaced it", async () => {
    const { session, sink } = await opened();
    session.file("src/small.ts");
    session.layout("split");
    const [page] = filePages(sink, "src/small.ts");
    expect(page?.layout).toBe("split");
    const pairs = page?.pairs as { left: MobileRow | null; right: MobileRow | null }[];
    expect(pairs.map((pair) => [pair.left?.text, pair.right?.text?.slice(0, 4)])).toEqual([
      ["keep", "keep"],
      ["old", "new"],
      ["x".repeat(2000), "xxxx"],
    ]);
    expect(sink.read("changes:summary")?.layout).toBe("split");
  });

  test("a file cut from the checkout's patch is read alone, page by page, to its end", async () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `+generated fixture row ${i + 1}`);
    const cutPatch = [
      "diff --git a/src/small.ts b/src/small.ts",
      "--- a/src/small.ts",
      "+++ b/src/small.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/data/huge.ts b/data/huge.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/data/huge.ts",
      "@@ -0,0 +1,20000 @@",
      ...huge,
      "",
    ].join("\n");
    const { session, sink } = await opened({
      patch: cutPatch,
      status: [
        status[0],
        { path: "data/huge.ts", status: "added", additions: 20_000, deletions: 0, binary: false },
      ] as typeof status,
    });
    expect(sink.read("changes:summary")?.patchTruncated).toBe(true);
    session.open("data/huge.ts", true);
    await until(() => filePages(sink, "data/huge.ts").length === 1, "first page");
    // The daemon's pages are read only as far as the pages asked for reach.
    while (fileHeader(sink, "data/huge.ts")?.remaining !== 0) {
      const pages = filePages(sink, "data/huge.ts").length;
      session.more("data/huge.ts");
      await until(() => filePages(sink, "data/huge.ts").length > pages, `page ${pages + 1}`);
    }
    expect(fileHeader(sink, "data/huge.ts")).toMatchObject({ complete: true, remaining: 0 });
    const all = rows(sink, "data/huge.ts");
    expect(all).toHaveLength(20_000);
    expect(all.at(-1)).toMatchObject({ new: 20_000, text: "generated fixture row 20000" });
  });

  test("several files stay open at once and expand-all opens every listed file", async () => {
    const { session, sink } = await opened();
    session.open("src/small.ts", true);
    session.open("src/big.ts", true);
    expect(sink.read("changes:summary")?.open).toEqual(["src/small.ts", "src/big.ts"]);
    expect(fileHeader(sink, "src/small.ts")).toBeDefined();
    session.expand(false);
    expect(fileHeader(sink, "src/small.ts")).toBeUndefined();
    expect(fileHeader(sink, "src/big.ts")).toBeUndefined();
    session.expand(true);
    expect(sink.read("changes:summary")?.open).toEqual(["src/big.ts", "src/small.ts"]);
  });

  test("the tree lists folders before files with their totals", async () => {
    const { sink } = await opened();
    expect(sink.read("changes:tree")?.rows).toEqual([
      expect.objectContaining({ kind: "folder", key: "src", files: 2, additions: 3001 }),
      expect.objectContaining({ kind: "file", key: "src/big.ts", depth: 1 }),
      expect.objectContaining({ kind: "file", key: "src/small.ts", depth: 1 }),
    ]);
  });

  test("commit and push goes through guarded git and the next step comes from the daemon", async () => {
    const { owner, session, sink } = await opened();
    void gitAction(
      owner,
      session,
      { kind: "commit", message: "Kill-all filters", push: true },
      "r1",
      sink,
      plainPreview,
    );
    await until(() => sink.read("git:r1") !== undefined, "git result");
    expect(sink.read("git:r1")).toMatchObject({ ok: true, message: "Committed and pushed" });
    await until(() => step(sink)?.kind === "create-pr", "next step");
    expect(sink.read("changes:summary")?.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  test("a commit is refused when someone else committed after the files were read", async () => {
    const { daemon, owner, session, sink } = await opened();
    daemon.workspace.setDetails("changes", { head: "c".repeat(40) });
    await gitAction(
      owner,
      session,
      { kind: "commit", message: "Late", push: false },
      "r2",
      sink,
      plainPreview,
    );
    expect(sink.read("git:r2")).toMatchObject({ ok: false });
    expect(String(sink.read("git:r2")?.message)).not.toContain("git_head_moved");
  });

  test("closing releases the patch and stops following", async () => {
    const { session, sink } = await opened();
    session.file("src/small.ts");
    session.close();
    expect(sink.read("changes:summary")).toBeUndefined();
    expect(fileHeader(sink, "src/small.ts")).toBeUndefined();
    expect(session.reads).toBeUndefined();
  });
});
