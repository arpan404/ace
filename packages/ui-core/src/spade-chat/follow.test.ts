import { expect, test } from "vitest";
import { SpadeConversationFollow, type SpadeFollowLink } from "./follow.ts";
import { parseSpadeEvents, type SpadeStored } from "./wire.ts";

/*
 * A conversation followed from events this device kept: what shows before Spade answers, what is
 * read, and what happens when Spade's history doesn't reach the kept events.
 */

/** A Spade the test plays: `history` answers reads in pages, and a stream sends its backlog. */
function spade(history: unknown[]) {
  const reads: string[] = [];
  /** While set, reads wait until `release`. */
  const held = { on: false, waiting: [] as (() => void)[] };
  const streams: string[] = [];
  const link: SpadeFollowLink = {
    canOpen: () => true,
    onOpenable: () => () => {},
    open(path, sink) {
      streams.push(path);
      const after = Number(/after=(\d+)/.exec(path)?.[1] ?? 0);
      queueMicrotask(() => {
        for (const stored of history.filter((each) => seqOf(each) > after))
          sink.frame("stored", JSON.stringify(stored));
        sink.frame("caught_up", JSON.stringify({ seq: history.length }));
      });
      return () => {};
    },
    async read(path) {
      reads.push(path);
      if (held.on) await new Promise<void>((resolve) => held.waiting.push(resolve));
      const after = Number(/after=(\d+)/.exec(path)?.[1] ?? 0);
      const limit = Number(/limit=(\d+)/.exec(path)?.[1] ?? Infinity);
      return JSON.stringify(history.filter((each) => seqOf(each) > after).slice(0, limit));
    },
  };
  const release = () => {
    held.on = false;
    for (const go of held.waiting.splice(0)) go();
  };
  return { link, reads, streams, held, release };
}

const seqOf = (stored: unknown) => (stored as { seq: number }).seq;

/** A message and its whole reply, as Spade stores them from `seq` on. */
function exchange(seq: number, words: string): unknown[] {
  const reply = `r${seq}`;
  return [
    { seq, at: seq, event: { type: "user_message", text: `Q${seq}` } },
    { seq: seq + 1, at: seq, event: { type: "reply_started", reply } },
    { seq: seq + 2, at: seq, event: { type: "reply_finished", reply, text: words } },
  ];
}

const parsed = (raw: unknown[]): SpadeStored[] => parseSpadeEvents(JSON.stringify(raw)) ?? [];
const deps = { frame: (callback: () => void) => callback(), later: () => () => {} };
const texts = (follow: SpadeConversationFollow) =>
  follow
    .get()
    .view.entries.flatMap((entry) =>
      entry.kind === "user"
        ? [entry.text]
        : entry.kind === "reply"
          ? entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
          : [],
    );
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("kept events show before Spade answers, and only what came after them is read", async () => {
  const kept = [...exchange(1, "First."), ...exchange(4, "Second.")];
  const { link, reads, streams } = spade([...kept, ...exchange(7, "Third.")]);
  const follow = new SpadeConversationFollow(link, "c1", deps);

  follow.seed(parsed(kept));

  expect(texts(follow)).toEqual(["Q1", "First.", "Q4", "Second."]);
  expect(follow.get().kept).toBe(true);
  expect(reads).toEqual([]);

  follow.start();
  follow.setReady(true);
  await settle();

  expect(reads[0]).toBe("/v1/conversations/c1/events?after=6&limit=200");
  expect(streams).toEqual(["/v1/conversations/c1/live?after=9"]);
  expect(texts(follow)).toEqual(["Q1", "First.", "Q4", "Second.", "Q7", "Third."]);
  expect(follow.get().kept).toBe(false);
});

test("kept events stay unconfirmed until Spade has answered, even with nothing new", async () => {
  const kept = exchange(1, "First.");
  const { link } = spade(kept);
  const follow = new SpadeConversationFollow(link, "c1", deps);
  follow.seed(parsed(kept));
  const seen: boolean[] = [];
  follow.subscribe(() => seen.push(follow.get().kept));

  follow.start();
  follow.setReady(true);
  await settle();

  // The empty page published the kept view still unconfirmed; the live catch-up confirmed it.
  expect(seen[0]).toBe(true);
  expect(follow.get().kept).toBe(false);
  expect(follow.get().view.caughtUp).toBe(true);
});

test("kept events Spade's history doesn't reach are dropped, and it is read from its start", async () => {
  const kept = [...exchange(1, "Old."), ...exchange(4, "Gone.")];
  const { link, reads } = spade(exchange(1, "Fresh."));
  const follow = new SpadeConversationFollow(link, "c1", deps);
  let resets = 0;
  follow.onReset(() => resets++);
  follow.seed(parsed(kept));

  follow.start();
  follow.setReady(true);
  await settle();
  await settle();

  expect(resets).toBe(1);
  expect(reads.at(-1)).toBe("/v1/conversations/c1/events?after=0&limit=200");
  expect(texts(follow)).toEqual(["Q1", "Fresh."]);
  expect(follow.get().kept).toBe(false);
});

/** A person's message stored at each of `seqs`. */
const messages = (seqs: number[]) =>
  seqs.map((seq) => ({ seq, at: seq, event: { type: "user_message", text: `M${seq}` } }));
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

test("told how many events Spade holds, a long history's pages are asked for at once", async () => {
  const { link, reads, held, release } = spade(messages(range(1, 1000)));
  const follow = new SpadeConversationFollow(link, "c1", deps);
  follow.expect(990);
  held.on = true;

  follow.start();
  follow.setReady(true);
  await settle();

  expect(reads).toEqual(
    [0, 200, 400, 600, 800].map((after) => `/v1/conversations/c1/events?after=${after}&limit=200`),
  );
  release();
  await settle();
  await settle();
  expect(texts(follow)).toEqual(range(1, 1000).map((seq) => `M${seq}`));
  expect(reads.at(-1)).toBe("/v1/conversations/c1/events?after=1000&limit=200");
});

test("pages read at once that don't line up are read again in turn, no event lost or repeated", async () => {
  // A history with a hole: the page after 200 starts past where the first page ends.
  const seqs = [...range(1, 150), ...range(300, 650)];
  const { link } = spade(messages(seqs));
  const follow = new SpadeConversationFollow(link, "c1", deps);
  follow.expect(650);

  follow.start();
  follow.setReady(true);
  for (let turn = 0; turn < 6; turn++) await settle();

  expect(texts(follow)).toEqual(seqs.map((seq) => `M${seq}`));
});
