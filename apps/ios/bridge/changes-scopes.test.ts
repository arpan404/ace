import { afterEach, describe, expect, test } from "vitest";
import type { MobileRow } from "@ace/ui-core/mobile";
import { fileHeader, filePages, openChanges } from "./changes-fixture.ts";
import type { RecordingSink } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function opened() {
  const sheet = await openChanges();
  closers.push(sheet.close);
  return sheet;
}
const summary = (sink: RecordingSink) => sink.read("changes:summary");
const paths = (sink: RecordingSink) =>
  ((summary(sink)?.files ?? []) as { path: string }[]).map((file) => file.path);
const changed = (sink: RecordingSink, path: string) =>
  filePages(sink, path)
    .flatMap((page) => page.lines as MobileRow[])
    .filter((row) => row.kind === "add" || row.kind === "del")
    .map((row) => `${row.kind} ${row.text}`);

describe("Changes sheet scopes", () => {
  test("a thread whose turns edited files opens on its last turn and offers every turn", async () => {
    const { sink } = await opened();
    expect(summary(sink)?.scope).toMatchObject({ id: "last", label: "Last turn", turn: 3 });
    expect(summary(sink)?.scopes).toEqual([
      { id: "working-tree", label: "Uncommitted", turn: null },
      { id: "last", label: "Last turn", turn: null },
      { id: "all", label: "This thread", turn: null },
      expect.objectContaining({ label: "Turn 1", turn: 1 }),
      expect.objectContaining({ label: "Turn 2", turn: 2 }),
      expect.objectContaining({ label: "Turn 3", turn: 3 }),
    ]);
    expect(paths(sink)).toEqual(["src/replay.ts"]);
  });

  test("a turn's diff shows that turn's edit; the whole thread composes them", async () => {
    const { session, sink } = await opened();
    session.open("src/replay.ts", true);
    expect(changed(sink, "src/replay.ts")).toEqual(["del line 15", "add line 15 changed"]);
    session.scope("all");
    expect(paths(sink)).toEqual(["src/replay.ts", "src/deep/nested/new.ts"]);
    expect(changed(sink, "src/replay.ts")).toEqual([
      "del line 5",
      "add line 5 changed",
      "del line 15",
      "add line 15 changed",
    ]);
    const second = ((summary(sink)?.scopes ?? []) as { id: string; turn: number | null }[]).find(
      (option) => option.turn === 2,
    );
    session.scope(second?.id ?? "");
    expect(paths(sink)).toEqual(["src/deep/nested/new.ts"]);
    // The file open in the earlier scope isn't in this one.
    expect(fileHeader(sink, "src/replay.ts")).toBeUndefined();
    expect(summary(sink)?.files).toEqual([
      expect.objectContaining({ status: "added", additions: 3, counted: true }),
    ]);
  });

  test("a turn's text edits are counted once the file has been diffed", async () => {
    const { session, sink } = await opened();
    expect(summary(sink)?.files).toEqual([
      expect.objectContaining({ path: "src/replay.ts", counted: false }),
    ]);
    session.open("src/replay.ts", true);
    expect(summary(sink)?.files).toEqual([
      expect.objectContaining({ additions: 1, deletions: 1, counted: true }),
    ]);
  });

  test("uncommitted reads the checkout instead of the turns", async () => {
    const { session, sink } = await opened();
    session.scope("working-tree");
    expect(summary(sink)?.scope).toMatchObject({ id: "working-tree", workingTree: true });
    session.open("src/replay.ts", true);
    expect(changed(sink, "src/replay.ts")).toEqual(["del line 5", "add line 5 changed"]);
  });

  test("a viewed mark survives reopening and clears when the file's diff changes", async () => {
    const { session, sink, kept, daemon } = await opened();
    session.scope("working-tree");
    session.open("src/replay.ts", true);
    session.viewed("src/replay.ts", true);
    expect(summary(sink)?.files).toEqual([expect.objectContaining({ viewed: true, open: false })]);
    await kept.flushed();
    session.open("src/replay.ts", true);
    expect(fileHeader(sink, "src/replay.ts")).toMatchObject({ viewed: true });
    daemon.workspace.setGitDiff(
      "changes",
      [
        "diff --git a/src/replay.ts b/src/replay.ts",
        "--- a/src/replay.ts",
        "+++ b/src/replay.ts",
        "@@ -5 +5 @@",
        "-line 5",
        "+line 5 changed again",
        "",
      ].join("\n"),
    );
    await session.refresh();
    expect(summary(sink)?.files).toEqual([expect.objectContaining({ viewed: false })]);
    expect(fileHeader(sink, "src/replay.ts")).toMatchObject({ viewed: false });
  });

  test("viewed marks and the layout come back after a relaunch", async () => {
    const first = await opened();
    first.session.scope("working-tree");
    first.session.viewed("src/replay.ts", true);
    first.session.layout("split");
    await first.kept.flushed();
    await first.close();
    closers.length = 0;
    const again = await openChanges({ value: first.value });
    closers.push(again.close);
    again.session.scope("working-tree");
    expect(again.sink.read("changes:summary")).toMatchObject({ layout: "split" });
    expect(again.sink.read("changes:summary")?.files).toEqual([
      expect.objectContaining({ viewed: true }),
    ]);
  });
});
