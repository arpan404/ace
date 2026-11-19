import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDevThread } from "./commands.ts";
import { lineageFile, type LineageFile, type LineageMark } from "./sequence-lineage.ts";
import { Store } from "./store.ts";

/*
 * A database rolled back behind the sequences it handed out (a restored or copied
 * `events.sqlite` under the same host id) is named afresh, so a client never resumes a cursor
 * that its new history will reuse (ADR 0128). The mark lives outside the database, beside it.
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

function home() {
  const root = mkdtempSync(join(tmpdir(), "ace-lineage-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function memoryMark(): LineageFile & { mark: LineageMark | undefined } {
  const file = {
    mark: undefined as LineageMark | undefined,
    read: () => file.mark,
    write(mark: LineageMark) {
      file.mark = mark;
    },
  };
  return file;
}
function open(path: string, lineage: LineageFile) {
  return new Store(path, () => {}, { lineage });
}
/** More than the daemon writes between marks, each event seen by a phone. */
function write(store: Store) {
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  for (let index = 0; index < 100; index++)
    store.appendEvents(thread.id, [{ type: "thread.updated", title: `Seen by a phone ${index}` }]);
}

test("a database rolled back behind the sequences it handed out is named afresh", () => {
  const root = home();
  const path = join(root, "events.sqlite");
  const lineage = memoryMark();
  let store = open(path, lineage);
  store.close();
  // A copy taken before anything was written.
  copyFileSync(path, join(root, "backup.sqlite"));
  store = open(path, lineage);
  write(store);
  const seen = store.sidebarToken();
  store.close();
  copyFileSync(join(root, "backup.sqlite"), path);
  store = open(path, lineage);
  cleanup.push(() => void store.close());
  expect(store.sidebarToken()).not.toBe(seen);
});

test("a database reopened as it was keeps its name across restarts and writes", () => {
  const path = join(home(), "events.sqlite");
  const lineage = memoryMark();
  let store = open(path, lineage);
  write(store);
  const named = store.sidebarToken();
  store.close();
  store = open(path, lineage);
  write(store);
  store.close();
  store = open(path, lineage);
  cleanup.push(() => void store.close());
  expect(store.sidebarToken()).toBe(named);
});

test("the mark survives on disk and an unreadable mark is read as none", () => {
  const root = home();
  const file = lineageFile(join(root, "sequence-mark.json"));
  expect(file.read()).toBeUndefined();
  file.write({ token: "abc", reserved: 65_537 });
  expect(lineageFile(join(root, "sequence-mark.json")).read()).toEqual({
    token: "abc",
    reserved: 65_537,
  });
  const broken = join(root, "broken.json");
  // Cut short by a crash mid-write: not trusted, and never fatal.
  writeFileSync(broken, '{"token":"ab');
  expect(lineageFile(broken).read()).toBeUndefined();
});
