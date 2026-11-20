import { beforeAll, describe, expect, it } from "vitest";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { BufferKey, TextBuffer } from "./types.ts";

beforeAll(ready);

const key = (path: string, root = "m1/t1"): BufferKey => ({ root, path });

function setup(files: Record<string, string>, capBytes = 1024 * 1024) {
  const disk = fakeDisk(files);
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    capBytes,
  });
  return { disk, time, registry };
}

function append(buffer: TextBuffer, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  const last = doc.lenLines() - 1;
  const end = { line: last, column: doc.line(last).length };
  doc.apply([{ range: { start: end, end }, text }]);
  buffer.edited();
}

describe("buffer registry", () => {
  it("gives two views of one path the same buffer, so an edit in one shows in the other", async () => {
    const { registry } = setup({ "a.ts": "one\n" });
    const left = registry.open(key("a.ts"));
    const right = registry.open(key("a.ts"));
    await settle();

    expect(right.buffer).toBe(left.buffer);
    append(left.buffer, "two\n");
    expect(right.buffer.document()?.text()).toBe("one\ntwo\n");
    expect(right.buffer.snapshot().dirty).toBe(true);
  });

  it("keeps the same path in two checkouts apart", async () => {
    const { registry } = setup({ "a.ts": "one\n" });
    const here = registry.open(key("a.ts"));
    const there = registry.open(key("a.ts", "m1/t2"));
    await settle();

    expect(there.buffer).not.toBe(here.buffer);
  });

  it("keeps a buffer while any holder has it and frees a saved one when the last lets go", async () => {
    const { disk, registry } = setup({ "a.ts": "one\n" });
    const tab = registry.open(key("a.ts"));
    const view = registry.open(key("a.ts"));
    await settle();

    tab.release();
    expect(view.buffer.document()?.text()).toBe("one\n");
    view.release();
    disk.write("a.ts", "changed while closed\n");

    const again = registry.open(key("a.ts"));
    await settle();
    expect(again.buffer).not.toBe(view.buffer);
    expect(again.buffer.document()?.text()).toBe("changed while closed\n");
  });

  it("keeps an unsaved buffer after its last holder lets go", async () => {
    const { registry } = setup({ "a.ts": "one\n" });
    const lease = registry.open(key("a.ts"));
    await settle();
    append(lease.buffer, "typed\n");
    lease.release();

    const again = registry.open(key("a.ts"));
    expect(again.buffer).toBe(lease.buffer);
    expect(again.buffer.document()?.text()).toBe("one\ntyped\n");
  });

  it("over the cap frees hidden saved buffers, least recently shown first", async () => {
    // Four 10-byte files under a 30-byte cap.
    const { time, registry } = setup(
      {
        "a.ts": "aaaaaaaaa\n",
        "b.ts": "bbbbbbbbb\n",
        "c.ts": "ccccccccc\n",
        "d.ts": "ddddddddd\n",
      },
      30,
    );
    const a = registry.open(key("a.ts"));
    const b = registry.open(key("b.ts"));
    const c = registry.open(key("c.ts"));
    for (const lease of [b, a, c]) {
      lease.setVisible(true);
      await settle();
      await time.advance(1_000);
      lease.setVisible(false);
    }
    expect(registry.residentBytes()).toBe(30);

    const d = registry.open(key("d.ts"));
    d.setVisible(true);
    await settle();

    // b was shown longest ago.
    expect(b.buffer.snapshot().status).toEqual({ kind: "evicted" });
    expect(b.buffer.document()).toBeUndefined();
    expect(a.buffer.document()?.text()).toBe("aaaaaaaaa\n");
    expect(registry.residentBytes()).toBe(30);
  });

  it("never frees an unsaved or a visible buffer, even over the cap", async () => {
    const { time, registry } = setup({ "a.ts": "aaaaaaaaa\n", "b.ts": "bbbbbbbbb\n" }, 10);
    const unsaved = registry.open(key("a.ts"));
    unsaved.setVisible(true);
    await settle();
    append(unsaved.buffer, "x");
    await time.advance(1_000);
    unsaved.setVisible(false);

    const visible = registry.open(key("b.ts"));
    visible.setVisible(true);
    await settle();

    expect(unsaved.buffer.snapshot().status).toEqual({ kind: "ready" });
    expect(visible.buffer.snapshot().status).toEqual({ kind: "ready" });
    expect(registry.residentBytes()).toBeGreaterThan(10);
  });

  it("reads a freed buffer's file again when it is shown", async () => {
    const { disk, registry } = setup({ "a.ts": "aaaaaaaaa\n", "b.ts": "bbbbbbbbb\n" }, 10);
    const a = registry.open(key("a.ts"));
    a.setVisible(true);
    await settle();
    a.setVisible(false);
    const b = registry.open(key("b.ts"));
    b.setVisible(true);
    await settle();
    expect(a.buffer.snapshot().status).toEqual({ kind: "evicted" });

    disk.write("a.ts", "new text\n");
    b.setVisible(false);
    a.setVisible(true);
    await settle();

    expect(a.buffer.snapshot().status).toEqual({ kind: "ready" });
    expect(a.buffer.document()?.text()).toBe("new text\n");
  });

  it("watches each open file's folder once per checkout", async () => {
    const { registry } = setup({ "src/a.ts": "", "src/b.ts": "", "c.ts": "" });
    registry.open(key("src/a.ts"));
    registry.open(key("src/b.ts"));
    registry.open(key("c.ts"));
    registry.open(key("src/a.ts", "m1/t2"));

    expect(registry.folders("m1/t1")).toEqual(["", "src"]);
  });
});
