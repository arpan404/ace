import { afterEach, describe, expect, test } from "vitest";
import type { MobileRow } from "@ace/ui-core/mobile";
import { fileHeader, filePages, openChanges } from "./changes-fixture.ts";
import { Sheets } from "./sheets.ts";
import { plainPreview, RecordingSink, until } from "./sheet-fixture.ts";

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
const scopeId = (sink: RecordingSink) => {
  const scope = summary(sink)?.scope;
  return typeof scope === "object" && scope !== null && "id" in scope ? scope.id : undefined;
};
const paths = (sink: RecordingSink) =>
  ((summary(sink)?.files ?? []) as { path: string }[]).map((file) => file.path);
const changed = (sink: RecordingSink, path: string) =>
  filePages(sink, path)
    .flatMap((page) => page.lines as MobileRow[])
    .filter((row) => row.kind === "add" || row.kind === "del")
    .map((row) => `${row.kind} ${row.text}`);

/** Sheets over the fixture's thread, as the phone's thread screen drives them. */
async function threadSheets() {
  const { client, owner } = await opened();
  const sink = new RecordingSink();
  const sheets = new Sheets(sink, plainPreview);
  closers.push(async () => sheets.close());
  const thread = { owner, store: client.thread("changes").store, threadId: "changes", epoch: 1 };
  return { sink, sheets, thread };
}

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

  test("a turn scope's progress counts files viewed at that scope's version of their diff", async () => {
    const { session, sink } = await opened();
    session.scope("all");
    expect(summary(sink)?.progress).toEqual({ viewed: 0, files: 2 });
    expect(session.viewed("src/deep/nested/new.ts", true)).toBe(true);
    expect(session.viewed("src/replay.ts", true)).toBe(true);
    expect(summary(sink)?.progress).toEqual({ viewed: 2, files: 2 });
    // The last turn's diff of the same file is another version: its mark doesn't carry over.
    session.scope("last");
    expect(paths(sink)).toEqual(["src/replay.ts"]);
    expect(summary(sink)?.progress).toEqual({ viewed: 0, files: 1 });
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

  test("Changes opened with a scope opens on it, and the next plain open is on the last turn", async () => {
    const { sink, sheets, thread } = await threadSheets();
    // The Summary's files changed count the whole thread, so its row opens This thread.
    expect(sheets.action(thread, { kind: "changes", open: true, scope: "all" })).toBe(true);
    await until(() => scopeId(sink) === "all", "This thread");
    expect(summary(sink)?.scope).toMatchObject({ label: "This thread" });
    sheets.action(thread, { kind: "changes", open: false });
    sheets.action(thread, { kind: "changes", open: true });
    await until(() => scopeId(sink) === "last", "Last turn");
  });

  test("a scope asked for while Changes is closed never reaches another thread's Changes", async () => {
    const { sink, sheets, thread } = await threadSheets();
    expect(sheets.action(thread, { kind: "changes.scope", scope: "all" })).toBe(false);
    // The person moves to another thread, and that thread's Changes opens on its last turn.
    sheets.close();
    const other = { ...thread, epoch: 2 };
    sheets.follow(other);
    expect(sheets.action(other, { kind: "changes", open: true })).toBe(true);
    await until(() => scopeId(sink) === "last", "Last turn");
  });

  test("Changes the person opens themselves is on the last turn, whatever was asked while closed", async () => {
    const { sink, sheets, thread } = await threadSheets();
    sheets.action(thread, { kind: "changes.scope", scope: "all" });
    expect(sheets.action(thread, { kind: "changes", open: true })).toBe(true);
    await until(() => scopeId(sink) === "last", "Last turn");
  });
});
