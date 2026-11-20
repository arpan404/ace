import { beforeAll, describe, expect, it } from "vitest";
import { createBufferRegistry } from "./registry.ts";
import { fakeDisk, inlineMerge, manualTime, memoryDrafts, ready, settle } from "./test-support.ts";
import type { TextBuffer } from "./types.ts";

beforeAll(ready);

const file = { root: "m1/t1", path: "store.ts" };

/** One app session: a registry over the same disk and device storage as the others. */
function session(disk: ReturnType<typeof fakeDisk>, drafts: ReturnType<typeof memoryDrafts>) {
  const time = manualTime();
  const registry = createBufferRegistry({
    files: disk.port,
    drafts: drafts.store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
  });
  return { time, registry };
}

async function opened(registry: ReturnType<typeof createBufferRegistry>) {
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  return lease.buffer;
}

function replaceLine(buffer: TextBuffer, line: number, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  const range = {
    start: { line, column: 0 },
    end: { line, column: doc.line(line).length },
  };
  doc.apply([{ range, text }]);
  buffer.edited();
}

describe("drafts", () => {
  it("survive a reload once typing pauses", async () => {
    const disk = fakeDisk({ "store.ts": "one\ntwo\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    replaceLine(await opened(first.registry), 0, "ONE");
    await first.time.advance(400);

    const reloaded = await opened(session(disk, drafts).registry);

    expect(reloaded.document()?.text()).toBe("ONE\ntwo\n");
    expect(reloaded.snapshot()).toMatchObject({ dirty: true, clash: undefined, version: "v1" });
  });

  it("are not written before typing pauses, and are written at once on flush", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    replaceLine(await opened(first.registry), 0, "ONE");
    await first.time.advance(399);
    expect(await drafts.store.get(file)).toBeUndefined();

    await first.registry.flushDrafts();

    expect(await drafts.store.get(file)).toEqual({
      text: "ONE\n",
      original: "one\n",
      version: "v1",
    });
  });

  it("are removed on save", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    const buffer = await opened(first.registry);
    replaceLine(buffer, 0, "ONE");
    await first.time.advance(400);

    expect(await buffer.save()).toEqual({ kind: "saved", version: "v2" });

    expect(await drafts.store.get(file)).toBeUndefined();
    const reloaded = await opened(session(disk, drafts).registry);
    expect(reloaded.snapshot()).toMatchObject({ dirty: false, version: "v2" });
    expect(reloaded.document()?.text()).toBe("ONE\n");
  });

  it("go away when the text is typed back to what was saved", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const { time, registry } = session(disk, drafts);
    const buffer = await opened(registry);
    replaceLine(buffer, 0, "ONE");
    await time.advance(400);
    replaceLine(buffer, 0, "one");
    await time.advance(400);

    expect(buffer.snapshot().dirty).toBe(false);
    expect(await drafts.store.get(file)).toBeUndefined();
  });

  it("from before an agent's write reopen with the clash, not over the agent's text", async () => {
    const disk = fakeDisk({ "store.ts": "one\ntwo\nthree\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    replaceLine(await opened(first.registry), 0, "ONE");
    await first.time.advance(400);
    disk.write("store.ts", "one\ntwo\nTHREE\n");

    const reloaded = await opened(session(disk, drafts).registry);

    expect(reloaded.document()?.text()).toBe("ONE\ntwo\nthree\n");
    expect(reloaded.snapshot().clash).toMatchObject({
      kind: "changed",
      theirs: { text: "one\ntwo\nTHREE\n", version: "v2" },
    });
    await reloaded.merge();
    expect(reloaded.document()?.text()).toBe("ONE\ntwo\nTHREE\n");
  });

  it("keep the text readable and editable when the daemon is offline at reload", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    replaceLine(await opened(first.registry), 0, "ONE");
    await first.time.advance(400);
    disk.setOffline(true);

    const reloaded = await opened(session(disk, drafts).registry);

    expect(reloaded.snapshot()).toMatchObject({ status: { kind: "ready" }, dirty: true });
    expect(reloaded.document()?.text()).toBe("ONE\n");
  });

  it("that cannot be stored say so, and the buffer stays unsaved", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    drafts.setFull(true);
    const { time, registry } = session(disk, drafts);
    const buffer = await opened(registry);
    replaceLine(buffer, 0, "ONE");
    await time.advance(400);

    expect(buffer.snapshot()).toMatchObject({ dirty: true, draftKept: false });
    expect(registry.unkept()).toEqual([buffer]);
  });

  it("of a checkout are listed for reopening their files", async () => {
    const disk = fakeDisk({ "store.ts": "one\n" });
    const drafts = memoryDrafts();
    const first = session(disk, drafts);
    replaceLine(await opened(first.registry), 0, "ONE");
    await first.time.advance(400);

    expect(await session(disk, drafts).registry.draftPaths("m1/t1")).toEqual(["store.ts"]);
    expect(await session(disk, drafts).registry.draftPaths("m1/t2")).toEqual([]);
  });
});

describe("Don't save", () => {
  it("drops the edits and reads the disk even when the device can't store drafts", async () => {
    const disk = fakeDisk({ "store.ts": "one\ntwo\n" });
    const drafts = memoryDrafts();
    const failing = {
      ...drafts,
      store: {
        ...drafts.store,
        put: () => Promise.reject(new Error("This browser can't keep drafts.")),
        delete: () => Promise.reject(new Error("This browser can't keep drafts.")),
      },
    };
    const { registry, time } = session(disk, failing);
    const buffer = await opened(registry);
    replaceLine(buffer, 0, "mine");
    time.advance(1_000);
    await settle();

    await buffer.discard();
    expect(buffer.snapshot().dirty).toBe(false);
    expect(buffer.document()?.text()).toBe("one\ntwo\n");
  });
});
