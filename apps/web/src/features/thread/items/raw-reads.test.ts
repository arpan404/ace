import type { RawPayload } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  canReadMore,
  initialRawReads,
  stepRawReads,
  type RawInput,
  type RawReads,
} from "./raw-reads.ts";

const payload = (marker: string): RawPayload => ({ type: "frame", data: { marker } });
const run = (state: RawReads, ...inputs: RawInput[]) => inputs.reduce(stepRawReads, state);
/** The reply to the read in flight. */
const answer = (
  state: RawReads,
  reply: { raw: string[]; next?: number; revision?: string; changed?: true },
): RawInput => ({
  type: "reply",
  id: state.read?.id ?? -1,
  reply: {
    from: state.read?.from ?? 0,
    raw: reply.raw.map(payload),
    revision: reply.revision ?? "r1",
    ...(reply.next === undefined ? {} : { next: reply.next }),
    ...(reply.changed ? { changed: reply.changed } : {}),
  },
});
const markers = (state: RawReads) =>
  state.raw.map((entry) => ("data" in entry ? (entry.data as { marker: string }).marker : ""));

/** Open, first page answered: idle with `a` shown and more to read. */
function shown(running: boolean) {
  const reading = run(initialRawReads(running), { type: "open" });
  return run(reading, answer(reading, { raw: ["a"], next: 1 }));
}

describe("the Raw view's reads", () => {
  it.each([
    {
      name: "opening reads the first page",
      state: () => initialRawReads(true),
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: 0, revision: undefined } },
    },
    {
      name: "a change during a read makes it stale, with no second read",
      state: () => run(initialRawReads(true), { type: "open" }),
      input: { type: "changed", running: true } as RawInput,
      expect: { phase: "stale", read: { id: 1 }, reads: 1 },
    },
    {
      name: "a change while idle and running waits for the timer",
      state: () => shown(true),
      input: { type: "changed", running: true } as RawInput,
      expect: { phase: "waiting", read: undefined },
    },
    {
      name: "the timer reads again from the start",
      state: () => run(shown(true), { type: "changed", running: true }),
      input: { type: "timer" } as RawInput,
      expect: { phase: "reading", read: { from: 0 } },
    },
    {
      name: "finishing while waiting reads at once",
      state: () => run(shown(true), { type: "changed", running: true }),
      input: { type: "changed", running: false } as RawInput,
      expect: { phase: "reading", read: { from: 0 }, running: false },
    },
    {
      name: "a change while idle after the step finished reads at once",
      state: () => shown(false),
      input: { type: "changed", running: false } as RawInput,
      expect: { phase: "reading", read: { from: 0 } },
    },
    {
      name: "a timer that fires with nothing waiting does nothing",
      state: () => shown(true),
      input: { type: "timer" } as RawInput,
      expect: { phase: "idle", read: undefined },
    },
    {
      name: "Show more reads the next page of the shown version",
      state: () => shown(true),
      input: { type: "more" } as RawInput,
      expect: { phase: "reading", read: { from: 1, revision: "r1" } },
    },
    {
      name: "Show more while a read is out does nothing",
      state: () => run(shown(true), { type: "more" }),
      input: { type: "more" } as RawInput,
      expect: { phase: "reading", reads: 2 },
    },
    {
      name: "a change while closed reads again on opening",
      state: () => run(shown(true), { type: "close" }, { type: "changed", running: false }),
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: 0 } },
    },
    {
      name: "reopening with nothing changed keeps what was read",
      state: () => run(shown(true), { type: "close" }),
      input: { type: "open" } as RawInput,
      expect: { phase: "idle", read: undefined },
    },
  ])("$name", ({ state, input, expect: expected }) => {
    expect(stepRawReads(state(), input)).toMatchObject(expected);
  });

  it("a stale read's reply is shown, then exactly one read from the start follows", () => {
    const first = run(initialRawReads(false), { type: "open" });
    const stale = run(
      first,
      { type: "changed", running: false },
      { type: "changed", running: false },
    );
    const after = stepRawReads(stale, answer(stale, { raw: ["old"] }));
    expect(markers(after)).toEqual(["old"]);
    expect(after).toMatchObject({ phase: "reading", read: { from: 0 }, reads: 2 });
    const done = stepRawReads(after, answer(after, { raw: ["final"] }));
    expect(done).toMatchObject({ phase: "idle", read: undefined, reads: 2 });
    expect(markers(done)).toEqual(["final"]);
  });

  it("a stale read that runs while the step runs waits for the timer instead", () => {
    const stale = run(initialRawReads(true), { type: "open" }, { type: "changed", running: true });
    expect(stepRawReads(stale, answer(stale, { raw: ["a"] }))).toMatchObject({ phase: "waiting" });
  });

  it("a refresh replaces the pages shown when it lands, and Show more reads on from it", () => {
    const two = run(shown(false), { type: "more" });
    const both = stepRawReads(two, answer(two, { raw: ["b"], next: 2 }));
    expect(markers(both)).toEqual(["a", "b"]);
    const refreshing = stepRawReads(both, { type: "changed", running: false });
    // The pages read stay on screen while the refresh is out.
    expect(markers(refreshing)).toEqual(["a", "b"]);
    expect(canReadMore(refreshing)).toBe(false);
    const fresh = stepRawReads(
      refreshing,
      answer(refreshing, { raw: ["A"], next: 1, revision: "r2" }),
    );
    expect(markers(fresh)).toEqual(["A"]);
    expect(stepRawReads(fresh, { type: "more" }).read).toMatchObject({ from: 1, revision: "r2" });
  });

  it("a page of a version that changed reads again from the start", () => {
    const more = run(shown(false), { type: "more" });
    const restart = stepRawReads(more, answer(more, { raw: [], changed: true, revision: "r2" }));
    expect(restart).toMatchObject({ phase: "reading", read: { from: 0, revision: undefined } });
    expect(markers(restart)).toEqual(["a"]);
  });

  it("a reply to any read but the one in flight changes nothing", () => {
    const open = run(initialRawReads(true), { type: "open" });
    const late = {
      type: "reply",
      id: 99,
      reply: { from: 0, raw: [payload("late")], revision: "r1" },
    } as const;
    expect(stepRawReads(open, late)).toBe(open);
    expect(stepRawReads(open, { type: "error", id: 99 })).toBe(open);
  });

  it("closing keeps the read out, follows nothing, and opening again waits for it", () => {
    const open = run(initialRawReads(true), { type: "open" });
    const closed = run(open, { type: "close" }, { type: "changed", running: false });
    // Opening again sends no second read while the first is out; the change makes it stale.
    const again = stepRawReads(closed, { type: "open" });
    expect(again).toMatchObject({ phase: "stale", read: { id: 1 }, reads: 1 });
    // A reply that lands while closed is kept, and the change waits for the next opening.
    const landed = stepRawReads(closed, answer(closed, { raw: ["a"] }));
    expect(landed).toMatchObject({ phase: "closed", read: undefined, changedWhileClosed: true });
    expect(markers(landed)).toEqual(["a"]);
    expect(stepRawReads(landed, { type: "open" })).toMatchObject({
      phase: "reading",
      read: { from: 0 },
    });
  });

  it("a failed read is retried as it was, and only when nothing is out", () => {
    const more = run(shown(false), { type: "more" });
    const failed = stepRawReads(more, { type: "error", id: more.read?.id ?? 0 });
    expect(failed).toMatchObject({ phase: "idle", failed: { from: 1 } });
    expect(stepRawReads(failed, { type: "retry" }).read).toMatchObject({ from: 1, revision: "r1" });
  });
});
