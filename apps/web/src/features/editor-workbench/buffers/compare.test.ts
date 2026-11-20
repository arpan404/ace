import { beforeAll, expect, test } from "vitest";
import type { Author } from "./attribution.ts";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { TextBuffer } from "./types.ts";

/*
 * Compare's two whole-file answers to an agent's change under unsaved edits (spec 46): Keep
 * mine keeps the buffer's text as the next save, now based on the disk's version; Take theirs
 * drops the unsaved edits for the disk's text.
 */

beforeAll(ready);

const file = { root: "m1/t1", path: "places.ts" };
const claude: Author = { kind: "agent", agent: "Claude Code", threadId: "t1" };

async function clashed() {
  const disk = fakeDisk({ "places.ts": "a\nb\n" });
  const drafts = memoryDrafts();
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => claude,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  const buffer = lease.buffer;
  replaceLine(buffer, 0, "mine");
  disk.write("places.ts", "a\ntheirs\n");
  registry.diskChanged(file);
  await settle();
  expect(buffer.snapshot().clash?.kind).toBe("changed");
  return { disk, drafts, buffer };
}

function replaceLine(buffer: TextBuffer, line: number, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  doc.apply([
    { range: { start: { line, column: 0 }, end: { line, column: doc.line(line).length } }, text },
  ]);
  buffer.edited();
}

test("Keep mine ends the clash, keeps the unsaved text, and the next save writes it over theirs", async () => {
  const { disk, buffer } = await clashed();

  await buffer.keepMine();

  expect(buffer.snapshot()).toMatchObject({ clash: undefined, dirty: true });
  expect(buffer.document()?.text()).toBe("mine\nb\n");
  // The gutter now compares against what is on disk.
  expect(buffer.baseText()).toBe("a\ntheirs\n");
  // Nothing was written until the person saves; then the save is no clash.
  expect(disk.text("places.ts")).toBe("a\ntheirs\n");
  expect((await buffer.save()).kind).toBe("saved");
  expect(disk.text("places.ts")).toBe("mine\nb\n");
});

test("Take theirs drops the unsaved edits and their draft for the disk's text", async () => {
  const { disk, drafts, buffer } = await clashed();

  await buffer.takeTheirs();
  await settle();

  expect(buffer.document()?.text()).toBe("a\ntheirs\n");
  expect(buffer.snapshot()).toMatchObject({ clash: undefined, dirty: false });
  expect(disk.text("places.ts")).toBe("a\ntheirs\n");
  expect(await drafts.store.get(file)).toBeUndefined();
});

test("Take theirs is one undoable step: undo brings the person's text back, unsaved", async () => {
  const { buffer } = await clashed();

  await buffer.takeTheirs();
  buffer.document()?.undo();
  buffer.edited();

  expect(buffer.document()?.text()).toBe("mine\nb\n");
});
