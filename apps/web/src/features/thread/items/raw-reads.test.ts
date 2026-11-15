import type { RawPayload } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  autoPages,
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

/**
 * Answer every read the machine sends, one payload per page with more after it, until it stops
 * reading on: `tag` at the first page of the batch, `tag<from>` after.
 */
function answerAll(state: RawReads, tag = "a", revision = "r1") {
  let current = state;
  for (let pages = 0; current.read && current.phase !== "closed"; pages++) {
    if (pages > 100) throw new Error("The machine never stopped reading on");
    const from = current.read.from;
    const marker = pages === 0 ? tag : `${tag}${from}`;
    current = stepRawReads(current, answer(current, { raw: [marker], next: from + 1, revision }));
  }
  return current;
}

/** Open, a whole batch answered: idle with `autoPages` pages shown and more to read. */
function shown(running: boolean) {
  return answerAll(run(initialRawReads(running), { type: "open" }));
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
      name: "a page with more after it reads on to the next by itself",
      state: () => run(initialRawReads(true), { type: "open" }),
      input: { type: "reply", id: 1, reply: { from: 0, raw: [], revision: "r1", next: 1 } } as RawInput,
      expect: { phase: "reading", read: { id: 2, from: 1, revision: "r1" }, auto: autoPages - 2 },
    },
    {
      name: "the last page needs no read after it",
      state: () => run(initialRawReads(true), { type: "open" }),
      input: { type: "reply", id: 1, reply: { from: 0, raw: [], revision: "r1" } } as RawInput,
      expect: { phase: "idle", read: undefined },
    },
    {
      name: "Show more reads the next batch of the shown version",
      state: () => shown(true),
      input: { type: "more" } as RawInput,
      expect: {
        phase: "reading",
        read: { from: autoPages, revision: "r1" },
        auto: autoPages - 1,
      },
    },
    {
      name: "Show more while a read is out does nothing",
      state: () => run(shown(true), { type: "more" }),
      input: { type: "more" } as RawInput,
      expect: { phase: "reading", reads: autoPages + 1 },
    },
    {
      name: "a batch cut short by closing reads on when the view opens again",
      state: () => {
        const first = run(initialRawReads(true), { type: "open" });
        const second = run(first, answer(first, { raw: ["a"], next: 1 }), { type: "close" });
        return run(second, answer(second, { raw: ["b"], next: 2 }));
      },
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: 2 }, reads: 3 },
    },
    {
      name: "a change while reading on makes the page stale; a new batch starts from the start",
      state: () => {
        const first = run(initialRawReads(false), { type: "open" });
        return run(first, answer(first, { raw: ["a"], next: 1 }), { type: "changed", running: false });
      },
      input: { type: "reply", id: 2, reply: { from: 1, raw: [], revision: "r1", next: 2 } } as RawInput,
      expect: { phase: "reading", read: { id: 3, from: 0 }, auto: autoPages - 1 },
    },
    {
      name: "a change while closed reads again on opening",
      state: () => run(shown(true), { type: "close" }, { type: "changed", running: false }),
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: 0 } },
    },
    {
      name: "a refresh owed when the view closed is read on reopening",
      state: () => run(shown(true), { type: "changed", running: true }, { type: "close" }),
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: 0 } },
    },
    {
      name: "a read that was out when the view closed is still waited for on reopening",
      state: () => run(shown(true), { type: "more" }, { type: "close" }),
      input: { type: "open" } as RawInput,
      expect: { phase: "reading", read: { from: autoPages }, reads: autoPages + 1 },
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

  it("a refresh replaces the pages shown when it lands, and reads on from it", () => {
    const both = answerAll(run(shown(false), { type: "more" }), "b");
    expect(markers(both)).toHaveLength(2 * autoPages);
    const refreshing = stepRawReads(both, { type: "changed", running: false });
    // The pages read stay on screen while the refresh is out.
    expect(markers(refreshing)).toHaveLength(2 * autoPages);
    expect(canReadMore(refreshing)).toBe(false);
    const fresh = stepRawReads(
      refreshing,
      answer(refreshing, { raw: ["A"], next: 1, revision: "r2" }),
    );
    expect(markers(fresh)).toEqual(["A"]);
    expect(fresh.read).toMatchObject({ from: 1, revision: "r2" });
  });

  it("a page of a version that changed reads again from the start", () => {
    const more = run(shown(false), { type: "more" });
    const restart = stepRawReads(more, answer(more, { raw: [], changed: true, revision: "r2" }));
    expect(restart).toMatchObject({ phase: "reading", read: { from: 0, revision: undefined } });
    expect(markers(restart)).toHaveLength(autoPages);
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
    expect(failed).toMatchObject({ phase: "idle", failed: { from: autoPages } });
    expect(stepRawReads(failed, { type: "retry" }).read).toMatchObject({
      from: autoPages,
      revision: "r1",
    });
  });
});

/** Pages each version has in the property's server: more than one batch. */
const pagesPerVersion = autoPages + 24;

/** A small seeded generator, so a failing sequence can be replayed. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("the Raw view's reads, over random sequences", () => {
  // A view showing a failure (with Retry) is the one open, idle state allowed to be behind.
  it("whenever it is open with nothing out or scheduled, it shows the step's current version", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed);
      // The server: the step's version, with more pages than one batch reads.
      let version = 1;
      let running = true;
      let state = initialRawReads(running);
      /** What the read in flight was answered from: the version when it was sent. */
      let answeredFrom: { id: number; version: number } | undefined;
      const log: string[] = [];
      for (let step = 0; step < 150; step++) {
        // The hook sends each read the machine names, once.
        if (state.read && answeredFrom?.id !== state.read.id)
          answeredFrom = { id: state.read.id, version };
        const choice = random();
        let input: RawInput;
        if (choice < 0.15) input = { type: "open" };
        else if (choice < 0.25) input = { type: "close" };
        else if (choice < 0.45) {
          version++;
          running = random() < 0.6;
          input = { type: "changed", running };
        } else if (choice < 0.7 && state.read && answeredFrom) {
          const { from, revision } = state.read;
          const at = answeredFrom.version;
          // A continuation of a version other than the server's is answered `changed`.
          input =
            from > 0 && revision !== `r${at}`
              ? {
                  type: "reply",
                  id: state.read.id,
                  reply: { from, raw: [], revision: `r${at}`, changed: true },
                }
              : {
                  type: "reply",
                  id: state.read.id,
                  reply: {
                    from,
                    raw: [payload(`v${at}p${from}`)],
                    revision: `r${at}`,
                    ...(from < pagesPerVersion - 1 ? { next: from + 1 } : {}),
                  },
                };
        } else if (choice < 0.75 && state.read) input = { type: "error", id: state.read.id };
        else if (choice < 0.78) input = { type: "retry" };
        else if (choice < 0.85) input = { type: "more" };
        // The hook runs the timer only while the machine waits (and the view is open).
        else if (choice < 0.95 && state.phase === "waiting") input = { type: "timer" };
        else continue;
        log.push(JSON.stringify(input));
        state = stepRawReads(state, input);
        const settled =
          state.phase === "idle" && state.read === undefined && state.started && !state.failed;
        if (settled) {
          expect(state.revision, `seed ${seed}: ${log.join(" ")}`).toBe(`r${version}`);
          // Settled with pages left means the batch is done: reading on never stalls.
          if (state.next !== undefined)
            expect(state.auto, `seed ${seed}: ${log.join(" ")}`).toBe(0);
        }
      }
    }
  });
});
