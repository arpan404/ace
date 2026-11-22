import { expect, test } from "vitest";
import type { SpadeFollowLink } from "@ace/ui-core/spade-chat";
import { SpadeKeptEvents } from "./spade-kept-events.ts";
import { memoryKeep } from "./spade-test-host.ts";

/*
 * What a conversation keeps of the events it read: every event from 1 to the last, never with a
 * gap, and nothing past the size cap as the phone stores it.
 */

const stored = (seq: number, text = `M${seq}`) => ({
  seq,
  at: seq,
  event: { type: "user_message", text },
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** A Spade whose history reads the test answers, in any order. */
function slowSpade() {
  const waiting = new Map<string, (body: string) => void>();
  const link: SpadeFollowLink = {
    canOpen: () => true,
    onOpenable: () => () => {},
    open: () => () => {},
    read: (path) => new Promise((resolve) => waiting.set(path, resolve)),
  };
  const answer = (after: number, seqs: number[]) =>
    waiting.get(`/v1/conversations/c1/events?after=${after}&limit=200`)?.(
      JSON.stringify(seqs.map((seq) => stored(seq))),
    );
  return { link, answer };
}

const now = () => () => {};
/** A save goes once the store is known to be this principal's: a tick later. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = (link: SpadeFollowLink, after: number) =>
  link.read(`/v1/conversations/c1/events?after=${after}&limit=200`).catch(() => "");
const savedSeqs = (keep: ReturnType<typeof memoryKeep>) =>
  (JSON.parse(keep.held.get("c1") ?? "[]") as { seq: number }[]).map((each) => each.seq);

test("a page that arrives before the one ahead of it is kept only once that one is, leaving no gap", async () => {
  const keep = memoryKeep();
  const kept = new SpadeKeptEvents(keep, now, (id) => id);
  const spade = slowSpade();
  const recorder = kept.record("c1", spade.link);
  // The first page stays out; the one after it answers.
  void page(recorder.link, 0);
  const second = page(recorder.link, 200);

  spade.answer(200, range(201, 400));
  await second;
  recorder.stop();
  await settled();
  // The later page alone: nothing of it kept, since 1 to 200 aren't.
  expect(savedSeqs(keep)).toEqual([]);

  const again = kept.record("c1", spade.link);
  const firstAgain = page(again.link, 0);
  const secondAgain = page(again.link, 200);
  spade.answer(200, range(201, 400));
  await secondAgain;
  spade.answer(0, range(1, 200));
  await firstAgain;
  again.stop();
  await settled();

  expect(savedSeqs(keep)).toEqual(range(1, 400));
});

test("a kept log with a gap in it isn't used", async () => {
  const keep = memoryKeep();
  keep.held.set("c1", JSON.stringify([stored(1), stored(2), stored(4)]));
  const kept = new SpadeKeptEvents(keep, now, (id) => id);

  expect(await kept.load("c1")).toBeUndefined();

  keep.held.set("c1", JSON.stringify([stored(1), stored(2), stored(3)]));
  expect((await kept.load("c1"))?.raw).toHaveLength(3);
});

test("the size cap counts what the phone stores, in UTF-8, for a log read back and a growing one", async () => {
  const keep = memoryKeep();
  // Under the cap in characters, past it in bytes: each é is two.
  const wide = "é".repeat(700_000);
  keep.held.set("c1", JSON.stringify([1, 2, 3].map((seq) => stored(seq, wide))));
  const kept = new SpadeKeptEvents(keep, now, (id) => id);

  expect(await kept.load("c1")).toBeUndefined();

  const link: SpadeFollowLink = {
    canOpen: () => true,
    onOpenable: () => () => {},
    open: () => () => {},
    read: async () => JSON.stringify([1, 2, 3].map((seq) => stored(seq, wide))),
  };
  const recorder = kept.record("c1", link);
  await page(recorder.link, 0);
  recorder.stop();
  await settled();

  // Past the cap the copy goes, rather than keep a part of the history.
  expect(keep.held.get("c1")).toBe("[]");
});
