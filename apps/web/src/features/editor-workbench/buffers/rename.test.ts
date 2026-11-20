import { beforeAll, describe, expect, it } from "vitest";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { TextBuffer } from "./types.ts";

/*
 * A file renamed or moved in this window (the explorer's Rename, a folder moved) takes its
 * unsaved edits and their draft along with its tabs, instead of leaving them under the old path.
 */

beforeAll(ready);

const root = "m1/t1";

function setup(
  files: Record<string, string>,
  disk = fakeDisk(files, root),
  drafts = memoryDrafts(),
) {
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
  });
  return { disk, drafts, time, registry };
}

function append(buffer: TextBuffer, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  const last = doc.lenLines() - 1;
  const end = { line: last, column: doc.line(last).length };
  doc.apply([{ range: { start: end, end }, text }]);
  buffer.edited();
}

/** The disk side of a rename: the file's text at its new path, nothing at the old one. */
function moveOnDisk(disk: ReturnType<typeof fakeDisk>, from: string, to: string) {
  disk.write(to, disk.text(from) ?? "");
  disk.remove(from);
}

describe("renaming a file with unsaved edits", () => {
  it("moves the buffer and its draft to the new path, with no clash", async () => {
    const { disk, drafts, time, registry } = setup({ "a.ts": "one\n" });
    const old = registry.open({ root, path: "a.ts" });
    old.setVisible(true);
    await settle();
    append(old.buffer, "typed\n");
    await time.advance(400);

    moveOnDisk(disk, "a.ts", "b.ts");
    registry.rename(root, (path) => (path === "a.ts" ? "b.ts" : undefined));
    // The editor's tabs follow: the old path's hold goes, the new path's comes.
    old.release();
    const moved = registry.open({ root, path: "b.ts" });
    moved.setVisible(true);
    registry.diskChanged({ root, path: "a.ts" });
    await settle();

    expect(moved.buffer.document()?.text()).toBe("one\ntyped\n");
    expect(moved.buffer.snapshot()).toMatchObject({ dirty: true, clash: undefined });
    expect(drafts.peek({ root, path: "b.ts" })).toBe("one\ntyped\n");
    expect(drafts.peek({ root, path: "a.ts" })).toBeUndefined();
    expect(registry.unsaved(root).map((buffer) => buffer.key.path)).toEqual(["b.ts"]);

    // A reload reopens the edits at the new path, without a clash.
    const reloaded = setup({}, disk, drafts).registry.open({ root, path: "b.ts" });
    await settle();
    expect(reloaded.buffer.document()?.text()).toBe("one\ntyped\n");
    expect(reloaded.buffer.snapshot()).toMatchObject({ dirty: true, clash: undefined });

    expect(await moved.buffer.save()).toMatchObject({ kind: "saved" });
    expect(disk.text("b.ts")).toBe("one\ntyped\n");
    expect(disk.text("a.ts")).toBeUndefined();
  });

  it("inside a renamed folder moves with it", async () => {
    const { disk, time, registry } = setup({ "src/x.ts": "x\n", "other/y.ts": "y\n" });
    const lease = registry.open({ root, path: "src/x.ts" });
    await settle();
    append(lease.buffer, "typed\n");
    await time.advance(400);

    moveOnDisk(disk, "src/x.ts", "lib/x.ts");
    registry.rename(root, (path) =>
      path.startsWith("src/") ? `lib/${path.slice("src/".length)}` : undefined,
    );
    lease.release();
    const moved = registry.open({ root, path: "lib/x.ts" });
    await settle();

    expect(moved.buffer.document()?.text()).toBe("x\ntyped\n");
    expect(moved.buffer.snapshot()).toMatchObject({ dirty: true, clash: undefined });
    expect(registry.get({ root, path: "src/x.ts" })).toBeUndefined();
  });
});
