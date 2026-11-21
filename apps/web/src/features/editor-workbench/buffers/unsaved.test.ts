import { beforeAll, describe, expect, it } from "vitest";
import type { Author } from "./attribution.ts";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";

beforeAll(ready);

const file = { root: "m1/t1", path: "notes.ts" };
const person: Author = { kind: "unknown" };

async function open(text: string) {
  const time = manualTime();
  const disk = fakeDisk({ "notes.ts": text });
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => person,
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  const buffer = lease.buffer;
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  const type = (text: string) => {
    doc.insertText(text);
    buffer.edited();
  };
  const undo = () => {
    doc.undo();
    buffer.edited();
  };
  const redo = () => {
    doc.redo();
    buffer.edited();
  };
  return { buffer, type, undo, redo };
}

describe("unsaved state", () => {
  it("clears at once when undo brings the text back to the opened file", async () => {
    const { buffer, type, undo } = await open("const a = 1;\n");
    type("x");
    expect(buffer.snapshot().dirty).toBe(true);

    undo();

    expect(buffer.snapshot().dirty).toBe(false);
  });

  it("clears when undo returns to the text last saved, and comes back on redo", async () => {
    const { buffer, type, undo, redo } = await open("a\n");
    type("1");
    await buffer.save();
    expect(buffer.snapshot().dirty).toBe(false);
    type("2");

    undo();
    expect(buffer.snapshot().dirty).toBe(false);

    redo();
    expect(buffer.snapshot().dirty).toBe(true);
  });
});
