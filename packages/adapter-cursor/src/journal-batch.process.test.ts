import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CursorJournal, CheckpointQuota, type CursorEnvelope } from "./index.ts";

const frame = (text: string): CursorEnvelope => ({
  schemaVersion: 1,
  generation: "host",
  operationId: "turn",
  segment: 0,
  kind: "delta",
  body: { type: "text-delta", text },
});

it("commits concurrent journal callbacks as an ordered durable group before releasing either", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-group-commit-")));
  const syncing = Promise.withResolvers<void>(),
    durable = Promise.withResolvers<void>();
  const journal = new CursorJournal(root, 65536, 4096, {
    maxCallbacks: 2,
    sync: async (file) => {
      syncing.resolve();
      await durable.promise;
      await file.sync();
    },
  });
  const recovered = new CursorJournal(root, 65536, 4096);
  let released = 0;
  try {
    await journal.recover(0, async () => {});
    const a = journal.append(frame("first")).then((value) => {
      released++;
      return value;
    });
    const b = journal.append(frame("second")).then((value) => {
      released++;
      return value;
    });
    await syncing.promise;
    // Real file I/O proves that both callbacks reached the same durability
    // barrier; a per-callback flush leaves only "first" on disk here.
    const written = await readFile(join(root, "ace-boundary.ndjson"), "utf8");
    expect(written).toContain('"text":"first"');
    expect(written).toContain('"text":"second"');
    expect(released).toBe(0);
    await expect(journal.append(frame("over limit"))).rejects.toThrow("budget");
    const closing = journal.close();
    durable.resolve();
    const commits = await Promise.all([a, b]);
    expect(commits.map((value) => value.boundaryOffset)).toEqual([1, 2]);
    await closing;
    const replay: CursorEnvelope[] = [];
    await recovered.recover(0, async (value) => {
      replay.push(value);
    });
    expect(replay).toEqual(commits.map((value) => Object.assign({}, value, { replayed: true })));
  } finally {
    durable.resolve();
    await journal.close();
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an oversized journal group before writing any callback and retains the previous recovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-group-quota-")));
  const journal = new CursorJournal(root, 800, 4096, { quota: new CheckpointQuota(root, 800) });
  const recovered = new CursorJournal(root, 800, 4096);
  try {
    await journal.recover(0, async () => {});
    const original = await journal.append(frame("original"));
    const before = await readFile(join(root, "ace-boundary.ndjson"), "utf8");
    const outcomes = await Promise.allSettled([
      journal.append(frame("a".repeat(300))),
      journal.append(frame("b".repeat(300))),
    ]);
    expect(outcomes.every((value) => value.status === "rejected")).toBe(true);
    expect(await readFile(join(root, "ace-boundary.ndjson"), "utf8")).toBe(before);
    await expect(journal.append(frame("later"))).rejects.toThrow("fenced");
    await journal.close();
    const replay: CursorEnvelope[] = [];
    await recovered.recover(0, async (value) => {
      replay.push(value);
    });
    expect(replay).toEqual([{ ...original, replayed: true }]);
  } finally {
    await journal.close();
    await recovered.close();
    await rm(root, { recursive: true, force: true });
  }
});
