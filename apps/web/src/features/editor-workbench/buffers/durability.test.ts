import { beforeAll, describe, expect, it } from "vitest";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { TextBuffer } from "./types.ts";

/*
 * The person's edits survive slow saves, slow device storage and a racing disk: the unsaved dot
 * always says whether the text differs from what was last saved, and a draft on the device
 * always matches what a reload should bring back.
 */

beforeAll(ready);

const file = { root: "m1/t1", path: "store.ts" };

function session(
  disk: ReturnType<typeof fakeDisk>,
  drafts: ReturnType<typeof memoryDrafts>,
  capBytes?: number,
) {
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    capBytes,
  });
  return { time, registry };
}

async function opened(registry: ReturnType<typeof createBufferRegistry>, path = file.path) {
  const lease = registry.open({ root: file.root, path });
  lease.setVisible(true);
  await settle();
  return lease;
}

function replaceLine(buffer: TextBuffer, line: number, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  const range = { start: { line, column: 0 }, end: { line, column: doc.line(line).length } };
  doc.apply([{ range, text }]);
  buffer.edited();
}

describe("a slow save", () => {
  it("that the person undoes under leaves the buffer unsaved against the saved text", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const { time, registry } = session(disk, drafts);
    const { buffer } = await opened(registry);
    replaceLine(buffer, 0, "TWO");
    const release = disk.holdWrites();
    const saving = buffer.save();

    // Undo back to the old disk text while the write is out; the draft's pause passes.
    buffer.document()?.undo();
    buffer.edited();
    await time.advance(400);
    release();
    expect(await saving).toEqual({ kind: "saved", version: "v2" });
    await settle();

    expect(disk.text("store.ts")).toBe("TWO\n");
    expect(buffer.document()?.text()).toBe("one\n");
    expect(buffer.snapshot()).toMatchObject({ dirty: true, version: "v2" });
    expect(drafts.peek(file)).toBe("one\n");
  });
});

describe("a draft", () => {
  it("is deleted after a save even when the buffer goes while an older write is out", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const { time, registry } = session(disk, drafts);
    const lease = await opened(registry);
    const { buffer } = lease;
    replaceLine(buffer, 0, "ONE");
    const release = drafts.hold();
    await time.advance(400);
    // The tab closes; its unsaved buffer stays until the save lands, then goes.
    lease.release();
    expect(await buffer.save()).toMatchObject({ kind: "saved" });
    await settle();
    release();
    await settle();

    expect(drafts.peek(file)).toBeUndefined();
    const reopened = await opened(session(disk, drafts).registry);
    expect(reopened.buffer.snapshot()).toMatchObject({ dirty: false, clash: undefined });
  });
});
