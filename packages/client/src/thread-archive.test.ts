import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { ThreadArchive, type ArchiveQuery } from "./thread-archive.ts";

/*
 * One thread's archive (ADR 0225). Item n has creation sequence 10n, as host-wide sequences
 * leave gaps. A read of items a..b is merged the way the daemon's window reply claims it.
 */

const seqOf = (n: number) => n * 10;
const notice = (n: number, text = `notice ${n}`): Item =>
  Item.parse({
    id: `item-${n}`,
    agentId: "root",
    type: "notice",
    level: "info",
    text,
    raw: [],
    createdAt: n,
    complete: true,
  });
const ask = (n: number): Item =>
  Item.parse({
    id: `item-${n}`,
    agentId: "root",
    type: "message",
    role: "user",
    parts: [{ type: "text", text: `ask ${n}` }],
    createdAt: n,
    complete: true,
  });
const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const seq = (id: string) => seqOf(Number(id.slice("item-".length)));

/** Merge items a..b as a read whole from `from` (null: the thread's start) through b. */
function read(
  archive: ThreadArchive,
  a: number,
  b: number,
  options: {
    from?: number | null;
    skip?: number[];
    make?: (n: number) => Item;
    confirmed?: boolean;
    clipped?: string[];
  } = {},
) {
  const items = numbers(a, b)
    .filter((n) => !options.skip?.includes(n))
    .map(options.make ?? ((n) => notice(n)));
  return archive.merge(
    { items, seq, from: options.from === undefined ? seqOf(a) : options.from, through: seqOf(b) },
    {
      confirmed: options.confirmed ?? true,
      ...(options.clipped ? { clipped: new Set(options.clipped) } : {}),
    },
  );
}
const shown = (archive: ThreadArchive, query: ArchiveQuery) =>
  archive.window(query)?.reply.items.map((item) => item.id);

test("a window inside what was read is answered with the daemon's cursors", () => {
  const archive = new ThreadArchive("t");
  read(archive, 100, 300);
  const answer = archive.window({ aroundSeq: seqOf(250), before: 49, after: 0 });
  expect(answer?.reply.items.map((item) => item.id)).toEqual(
    numbers(201, 250).map((n) => `item-${n}`),
  );
  expect(answer?.reply.itemsBefore).toBe(seqOf(201));
  expect(answer?.reply.targetSeq).toBe(seqOf(250));
  expect(answer?.reply.itemsAfter).toBe(seqOf(250));
});

test("at the edge of what was read, the next older read goes to the daemon instead of stalling", () => {
  const archive = new ThreadArchive("t");
  read(archive, 100, 300);
  const partial = archive.window({ aroundSeq: seqOf(150), before: 199, after: 0 });
  expect(partial?.reply.items).toHaveLength(51);
  expect(partial?.reply.itemsBefore).toBe(seqOf(100));
  expect(archive.window({ aroundSeq: seqOf(100), before: 199, after: 0 })).toBeUndefined();
});

test("past the newest item read, a newer read goes to the daemon", () => {
  const archive = new ThreadArchive("t");
  read(archive, 100, 300);
  expect(shown(archive, { aroundSeq: seqOf(290) + 1, before: 0, after: 198 })).toEqual(
    numbers(291, 300).map((n) => `item-${n}`),
  );
  expect(archive.window({ aroundSeq: seqOf(300) + 1, before: 0, after: 198 })).toBeUndefined();
});

test("history read back to the thread's start says there is nothing older", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 40, { from: null });
  const answer = archive.window({ aroundSeq: seqOf(20), before: 199, after: 0 });
  expect(answer?.reply.items).toHaveLength(20);
  expect(answer?.reply.itemsBefore).toBeNull();
});

test("reads that meet become one, so a window spans both", () => {
  const archive = new ThreadArchive("t");
  read(archive, 100, 200);
  // A newer read aimed just past item 200 holds everything from there on.
  read(archive, 201, 300, { from: seqOf(200) + 1 });
  expect(shown(archive, { aroundSeq: seqOf(195), before: 0, after: 10 })).toEqual(
    numbers(195, 205).map((n) => `item-${n}`),
  );
});

test("reads with a gap between them stay apart and never answer across it", () => {
  const archive = new ThreadArchive("t");
  read(archive, 100, 200);
  read(archive, 250, 300);
  expect(shown(archive, { aroundSeq: seqOf(195), before: 0, after: 20 })).toEqual(
    numbers(195, 200).map((n) => `item-${n}`),
  );
  expect(archive.window({ aroundSeq: seqOf(260), before: 199, after: 0 })?.reply.itemsBefore).toBe(
    seqOf(250),
  );
});

test("an item missing from a later read of the same range was deleted", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 50);
  expect(read(archive, 1, 50, { skip: [20] })).toBe(true);
  expect(shown(archive, { aroundSeq: seqOf(25), before: 5, after: 0 })).toEqual(
    [19, 21, 22, 23, 24, 25].map((n) => `item-${n}`),
  );
});

test("a read leaves items outside its range alone", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 100);
  read(archive, 40, 60, { skip: [10] });
  expect(shown(archive, { itemId: "item-10", before: 0, after: 0 })).toEqual(["item-10"]);
});

test("reading the same finished items again changes nothing", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 50);
  expect(read(archive, 1, 50)).toBe(false);
});

test("a copy the live store clipped never replaces the whole one", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 5, { make: (n) => notice(n, n === 3 ? "the whole long text" : `notice ${n}`) });
  read(archive, 1, 5, {
    make: (n) => notice(n, n === 3 ? "text" : `notice ${n}`),
    clipped: ["item-3"],
  });
  const item = archive.window({ itemId: "item-3", before: 0, after: 0 })?.reply.items[0];
  expect(item?.type === "notice" && item.text).toBe("the whole long text");
});

test("older history comes in whole turns: it starts at a person's message", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 100, { from: seqOf(1), make: (n) => (n % 10 === 1 ? ask(n) : notice(n)) });
  // 25 older items from item 80 reach item 55; the turn there starts at item 61.
  expect(
    shown(archive, { aroundSeq: seqOf(80), before: 25, after: 0, wholeTurns: true })?.[0],
  ).toBe("item-61");
});

test("a window of items read this session is confirmed; one restored from disk is not", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 50);
  expect(archive.window({ aroundSeq: seqOf(30), before: 5, after: 5 })?.confirmed).toBe(true);
  const restored = new ThreadArchive("t");
  restored.restore(archive.record());
  expect(restored.window({ aroundSeq: seqOf(30), before: 5, after: 5 })?.confirmed).toBe(false);
});

test("a kept record answers the same windows, and an item it lacks splits the run there", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 100, { from: null });
  const record = archive.record();
  const whole = new ThreadArchive("t");
  whole.restore(record);
  expect(shown(whole, { aroundSeq: seqOf(60), before: 199, after: 0 })).toHaveLength(60);
  const { ["item-40"]: _lost, ...items } = record.items;
  const split = new ThreadArchive("t");
  split.restore({ ...record, items });
  expect(shown(split, { aroundSeq: seqOf(60), before: 199, after: 0 })).toEqual(
    numbers(41, 60).map((n) => `item-${n}`),
  );
  expect(split.window({ aroundSeq: seqOf(41), before: 199, after: 0 })).toBeUndefined();
  expect(shown(split, { aroundSeq: seqOf(39), before: 199, after: 0 })).toHaveLength(39);
});

test("an unfinished item is held but not kept on disk", () => {
  const archive = new ThreadArchive("t");
  read(archive, 1, 3, {
    make: (n) => (n === 3 ? Item.parse({ ...notice(n), complete: false }) : notice(n)),
  });
  expect(shown(archive, { itemId: "item-3", before: 0, after: 0 })).toEqual(["item-3"]);
  expect(Object.keys(archive.record().items)).toEqual(["item-1", "item-2"]);
});
