import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CheckpointQuota, CursorJournal, type CursorEnvelope } from "./index.ts";

let root: string;
const journalPath = () => join(root, "ace-boundary.ndjson");
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cursor-compaction-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const frame = (text: string, extra: Partial<CursorEnvelope> = {}): CursorEnvelope => ({
  schemaVersion: 1,
  generation: "host",
  operationId: "turn",
  segment: 0,
  kind: "delta",
  body: { type: "text-delta", text },
  ...extra,
});

/** Appends a turn of frames, each acknowledged as ace storing it would, then settles it. */
async function turn(journal: CursorJournal, label: string, frames = 4): Promise<CursorEnvelope[]> {
  const committed: CursorEnvelope[] = [];
  for (let index = 0; index < frames; index++) {
    const value = await journal.append(frame(`${label}-${index} ${"x".repeat(64)}`));
    journal.acknowledge(value.boundaryOffset ?? 0);
    committed.push(value);
  }
  await journal.settle();
  return committed;
}

async function reopen(after: number, options: ConstructorParameters<typeof CursorJournal>[3] = {}) {
  const journal = new CursorJournal(root, 1 << 20, 4096, options);
  const replayed: CursorEnvelope[] = [];
  await journal.recover(after, async (value) => {
    replayed.push(value);
  });
  return { journal, replayed };
}

it("a compacted journal recovers to the same offset and replays only uncommitted frames", async () => {
  const { journal } = await reopen(0);
  const observed = await journal.append(
    frame("observed", { kind: "observe", runId: "run-1", observeOffset: "sdk-offset-7" }),
  );
  journal.acknowledge(observed.boundaryOffset ?? 0);
  for (let index = 0; index < 4; index++) await turn(journal, `turn-${index}`);
  const before = (await stat(journalPath())).size;
  const unstored = [await journal.append(frame("unstored-a")), await journal.append(frame("b"))];
  await journal.close();
  expect((await readFile(journalPath(), "utf8")).includes("observed")).toBe(false);
  expect(before).toBeLessThan(17 * 120);

  const { journal: next, replayed } = await reopen(17);
  try {
    expect(replayed).toEqual(unstored.map((value) => Object.assign({}, value, { replayed: true })));
    expect(next.afterObserve("run-1")).toBe("sdk-offset-7");
    expect((await next.append(frame("after"))).boundaryOffset).toBe(20);
  } finally {
    await next.close();
  }
});

it("never drops a frame ace has not confirmed storing", async () => {
  const { journal } = await reopen(0);
  for (let index = 0; index < 8; index++) await journal.append(frame(`unconfirmed-${index}`));
  await journal.settle();
  await journal.settle();
  await journal.close();
  const { journal: next, replayed } = await reopen(0);
  await next.close();
  expect(replayed.map((value) => value.boundaryOffset)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it("recovery refuses a cursor older than the frames compaction dropped", async () => {
  const { journal } = await reopen(0);
  for (let index = 0; index < 4; index++) await turn(journal, `turn-${index}`);
  await journal.close();
  await expect(reopen(2)).rejects.toThrow("predates its compacted journal");
});

it("a crash mid-compaction leaves a journal that still recovers", async () => {
  const { journal } = await reopen(0);
  const committed: CursorEnvelope[] = [];
  for (let index = 0; index < 3; index++) committed.push(...(await turn(journal, `turn-${index}`)));
  await journal.close();
  const intact = await readFile(journalPath(), "utf8");
  // A crash before the rename leaves a half-written next journal beside the old one.
  await writeFile(
    `${journalPath()}.compact`,
    '{"aceJournal":2,"baseOffset":4,"observe":[]}\n{"tor',
  );

  const { journal: next, replayed } = await reopen(10);
  try {
    expect(replayed).toEqual(
      committed.slice(10).map((value) => Object.assign({}, value, { replayed: true })),
    );
    expect(await readFile(journalPath(), "utf8")).toBe(intact);
    await expect(stat(`${journalPath()}.compact`)).rejects.toThrow("ENOENT");
    expect((await next.append(frame("after"))).boundaryOffset).toBe(13);
  } finally {
    await next.close();
  }
});

it("an old-format journal still recovers and then compacts", async () => {
  const lines = [1, 2, 3, 4, 5, 6].map(
    (offset) => JSON.stringify({ ...frame(`old-${offset}`), boundaryOffset: offset }) + "\n",
  );
  await writeFile(journalPath(), lines.join(""));
  const { journal, replayed } = await reopen(4);
  expect(replayed.map((value) => value.boundaryOffset)).toEqual([5, 6]);
  journal.acknowledge(6);
  await journal.settle();
  await turn(journal, "new");
  await journal.close();
  expect(await readFile(journalPath(), "utf8")).not.toContain("old-4");
  const { journal: next, replayed: after } = await reopen(10);
  await next.close();
  expect(after).toEqual([]);
});

it("a long thread's journal size stays bounded across many settled turns", async () => {
  const { journal } = await reopen(0);
  const sizes: number[] = [];
  for (let index = 0; index < 300; index++) {
    await turn(journal, `turn-${index}`);
    sizes.push((await stat(journalPath())).size);
  }
  await journal.close();
  const oneTurn = 4 * 220;
  expect(Math.max(...sizes.slice(10))).toBeLessThan(6 * oneTurn);
  const { journal: next, replayed } = await reopen(1200);
  try {
    expect(replayed).toEqual([]);
    expect((await next.append(frame("after"))).boundaryOffset).toBe(1201);
  } finally {
    await next.close();
  }
});

it("frames appended while a compaction runs are all kept", async () => {
  const { journal } = await reopen(0);
  for (let index = 0; index < 3; index++) await turn(journal, `turn-${index}`);
  for (let index = 0; index < 6; index++) await journal.append(frame(`pad-${index}`));
  journal.acknowledge(18);
  const compaction = journal.settle();
  const during = await Promise.all(
    [0, 1, 2, 3].map((index) => journal.append(frame(`during-${index}`))),
  );
  await compaction;
  await journal.append(frame("final"));
  await journal.close();
  expect(await readFile(journalPath(), "utf8")).not.toContain("turn-0-0");
  const { journal: next, replayed } = await reopen(18);
  await next.close();
  expect(replayed.map((value) => value.body)).toEqual([
    ...during.map((value) => value.body),
    frame("final").body,
  ]);
});

it("compaction frees the journal's share of the checkpoint budget", async () => {
  const budget = 16384;
  const quota = new CheckpointQuota(root, budget);
  const { journal } = await reopen(0, { quota });
  // Without compaction these turns write about three times the budget.
  for (let index = 0; index < 60; index++) await turn(journal, `turn-${index}`);
  await journal.close();
  expect((await stat(journalPath())).size).toBeLessThan(budget);
  const { journal: next } = await reopen(240);
  await next.close();
});
