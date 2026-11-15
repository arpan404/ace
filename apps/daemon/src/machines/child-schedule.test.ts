import { expect, test, vi } from "vitest";
import { RECHECK_POLLS, RECHECK_SLOWEST_POLLS, RECHECK_WINDOW_MS } from "./child-recheck.ts";
import {
  asksAlone,
  defaultScheduleConfig,
  restored,
  foldCall,
  heardFrom,
  machineBack,
  machineDown,
  nextDue,
  planTurn,
  type CallOutcome,
  type ChildRecord,
  type ScheduleChild,
  type ScheduleConfig,
} from "./child-schedule.ts";

/*
 * Properties of the scheduler, checked on generated machines: children with failure patterns
 * (always fails, fails only when batched with a given child, times out, not_found, flapping,
 * unpaired, mixed) driven turn by turn, with restarts mid-run.
 */

// Each property simulates machines of up to 1,000 children for many minutes, turn by turn.
vi.setConfig({ testTimeout: 30_000 });

const POLL = 1000;
const MINUTE = 60_000;
/** A call that times out takes this long to come back (a status read's own timeout). */
const TIMEOUT_MS = 10_000;

type Behaviour =
  | { kind: "healthy" }
  | { kind: "fails" }
  | { kind: "poisons" }
  | { kind: "times_out" }
  | { kind: "not_found" }
  | { kind: "flapping" }
  /** Answered, but each reply arrives `ms` after its read went out, after later events. */
  | { kind: "delayed"; ms: number };

interface SimChild extends ScheduleChild {
  behaviour: Behaviour;
}

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const kinds: Exclude<Behaviour["kind"], "delayed">[] = [
  "healthy",
  "fails",
  "poisons",
  "times_out",
  "not_found",
  "flapping",
];

/** A machine of `count` children, mixed: working and settled of various ages, some unpaired. */
/** How a machine's children are split between working and settled. */
type Population = "mixed" | "working" | "settled";

function generate(
  seed: number,
  count: number,
  start: number,
  population: Population = "mixed",
  failing = 1,
): SimChild[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const pick = next();
    // `failing` scales how many children fail in some way: 1 is about five in six, 0 none.
    const kind =
      index === 0 || next() >= failing
        ? "healthy"
        : (kinds[Math.floor(pick * kinds.length)] ?? "healthy");
    const split = next();
    const settled = population === "settled" || (population === "mixed" && split < 0.6);
    const age = Math.floor(next() * 2 * RECHECK_WINDOW_MS);
    return {
      id: `child-${String(index).padStart(4, "0")}`,
      settled,
      settledAt: settled ? start - age : null,
      unconfirmed: settled && next() < 0.1,
      paired: next() < 0.9,
      behaviour: { kind },
    };
  });
}

interface Trace {
  /** When each child was asked. */
  asked: Map<string, number[]>;
  /** Every call made: when, and which children. */
  calls: { at: number; ids: string[] }[];
  /** Children the scheduler let go of, and when. */
  ended: Map<string, number>;
  /** For each child let go of, when the read that ended it went out. */
  endedBy: Map<string, number>;
  /** When each child's reads failed, by when they were sent. */
  failedAt: Map<string, number[]>;
  /** When each child's read was last answered, by the simulated machine. */
  answeredAt: Map<string, number[]>;
  /** Isolation breaches: a call mixing a child whose call failed with others. */
  breaches: string[];
}

/** What the machine answers for one call, given who is in it and how many times each was asked. */
function outcome(call: readonly string[], byId: Map<string, SimChild>, asks: Map<string, number>) {
  const members = call.map((id) => byId.get(id));
  if (members.some((child) => child?.behaviour.kind === "not_found"))
    return { kind: "not_found" } as CallOutcome;
  if (members.some((child) => child?.behaviour.kind === "fails"))
    return { kind: "failed" } as const;
  if (call.length > 1 && members.some((child) => child?.behaviour.kind === "poisons"))
    return { kind: "failed" } as const;
  if (
    members.some(
      (child) => child?.behaviour.kind === "flapping" && (asks.get(child.id) ?? 0) % 2 === 1,
    )
  )
    return { kind: "failed" } as const;
  return { kind: "answered" } as const;
}

/**
 * Runs the scheduler against a machine for `ms`, a turn a poll, restarting it (forgetting every
 * record) at `restarts`. Calls with a timing-out child come back after TIMEOUT_MS as failed.
 */
function simulate(
  children: SimChild[],
  ms: number,
  restarts: number[] = [],
  start = 0,
  /** Every call sent in [from, to) finds the machine down and fails at once. */
  outage?: { from: number; to: number },
  /**
   * Other calls to the machine that got through (a description, say), as the directory reports
   * them: when each was sent and when its reply arrived.
   */
  others: readonly { sent: number; now: number }[] = [],
) {
  const byId = new Map(children.map((child) => [child.id, child]));
  let config: ScheduleConfig = defaultScheduleConfig(POLL, start);
  let records = new Map<string, ChildRecord>();
  let tracked = [...children];
  const asks = new Map<string, number>();
  const trace: Trace = {
    asked: new Map(),
    calls: [],
    ended: new Map(),
    endedBy: new Map(),
    failedAt: new Map(),
    answeredAt: new Map(),
    breaches: [],
  };
  /** Children whose last call failed or was refused, until a call of them alone is answered. */
  const tainted = new Set<string>();
  const pending: { at: number; started: number; ids: string[]; result: CallOutcome }[] = [];
  /** When the machine was last known up, as the shell keeps it. */
  let heard: number | undefined;
  /** When the read that began the machine's current down episode went out, if it is down. */
  let downSince: number | undefined;
  const fold = (ids: string[], given: CallOutcome, now: number, started = now) => {
    // A failure while nothing else there answered is the machine's (as the shell marks it).
    const machineWide = machineDown(heard, started, config);
    const result: CallOutcome = given.kind === "failed" ? { kind: "failed", machineWide } : given;
    if (result.kind === "failed" && machineWide) downSince ??= started;
    const folded = foldCall(records, tracked, ids, result, { sent: started, now }, config);
    records = folded.records;
    if (result.kind !== "failed") {
      heard = heardFrom(heard, { sent: started, now });
      // The directory's recovery callback, as wired in the daemon: a call sent once the machine
      // was down got through, so it is back. One sent before then proves nothing of now.
      if (downSince !== undefined && started >= downSince) {
        records = machineBack(records, now);
        downSince = undefined;
      }
    }
    for (const id of folded.ended) {
      trace.ended.set(id, now);
      trace.endedBy.set(id, started);
    }
    tracked = tracked.filter((child) => !folded.ended.includes(child.id));
    if (result.kind === "answered") {
      for (const id of ids) {
        const list = trace.answeredAt.get(id) ?? [];
        list.push(now);
        trace.answeredAt.set(id, list);
      }
      if (ids.length === 1 && ids[0]) tainted.delete(ids[0]);
    } else
      for (const id of ids) {
        tainted.add(id);
        if (result.kind === "failed")
          trace.failedAt.set(id, [...(trace.failedAt.get(id) ?? []), started]);
      }
  };
  for (let now = start; now <= start + ms; now += POLL) {
    if (restarts.includes(now)) {
      // A restart forgets every record but the one flag the shell saves with each child: that it
      // is asked alone.
      const saved = [...records].filter(([, rec]) => asksAlone(rec, now)).map(([id]) => id);
      records = new Map(saved.map((id) => [id, restored()]));
      config = defaultScheduleConfig(POLL, now);
      // Calls on their way when it stopped never come back.
      pending.splice(0);
    }
    for (const call of pending.filter((entry) => entry.at <= now))
      fold(call.ids, call.result, now, call.started);
    for (const other of others.filter((entry) => entry.now <= now && entry.now > now - POLL)) {
      heard = heardFrom(heard, other);
      if (downSince !== undefined && other.sent >= downSince) {
        records = machineBack(records, now);
        downSince = undefined;
      }
    }
    pending.splice(0, pending.length, ...pending.filter((entry) => entry.at > now));
    const plan = planTurn(tracked, records, now, config);
    records = plan.records;
    for (const ids of plan.calls) {
      trace.calls.push({ at: now, ids });
      if (ids.length > 1 && ids.some((id) => tainted.has(id)))
        trace.breaches.push(`${now}: ${ids.join(",")}`);
      for (const id of ids) {
        const list = trace.asked.get(id) ?? [];
        list.push(now);
        trace.asked.set(id, list);
        asks.set(id, (asks.get(id) ?? 0) + 1);
      }
      const down = outage !== undefined && now >= outage.from && now < outage.to;
      if (down) {
        fold(ids, { kind: "failed" }, now);
        continue;
      }
      const result = outcome(ids, byId, asks);
      const delay = Math.max(
        0,
        ...ids.map((id) => {
          const behaviour = byId.get(id)?.behaviour;
          return behaviour?.kind === "delayed" ? behaviour.ms : 0;
        }),
      );
      if (ids.some((id) => byId.get(id)?.behaviour.kind === "times_out"))
        pending.push({ at: now + TIMEOUT_MS, started: now, ids, result: { kind: "failed" } });
      else if (delay > 0) pending.push({ at: now + delay, started: now, ids, result });
      else fold(ids, result, now);
    }
  }
  return trace;
}

const gaps = (times: readonly number[]) =>
  times.slice(1).map((at, index) => at - (times[index] ?? at));

/** The longest wait between checks a healthy child can see, by its kind, with n children there. */
function bound(child: ScheduleChild, n: number, now: number) {
  const config = defaultScheduleConfig(POLL, 0);
  const turns = Math.ceil(n / config.callsPerTurn) + 1;
  // One failed call it shared (a timeout at most) before the culprit is asked alone.
  const slack = turns * POLL + TIMEOUT_MS + POLL;
  if (!child.settled) return POLL + slack;
  const expired = child.settledAt !== null && now - child.settledAt >= RECHECK_WINDOW_MS;
  const fast = RECHECK_POLLS * POLL;
  if (expired || child.unconfirmed || child.settledAt === null) return fast + slack;
  return RECHECK_SLOWEST_POLLS * POLL + slack;
}

const seeds = Array.from({ length: 12 }, (_, index) => index + 1);

test("a. holds on machines of up to 1,000 children, all working, all settled or mixed", () => {
  for (const [count, population, failing] of [
    [256, "working", 0],
    [1000, "working", 0],
    [1000, "working", 0.2],
    [1000, "settled", 0.2],
    [1000, "mixed", 0.2],
  ] as const) {
    const children = generate(7, count, 0, population, failing);
    const trace = simulate(children, 4 * MINUTE);
    for (const child of children) {
      if (child.behaviour.kind !== "healthy" || !child.paired || trace.ended.has(child.id))
        continue;
      // Working children are due every poll, so each is read within the bound throughout;
      // settled ones at least once within the bound of start.
      const asked = trace.asked.get(child.id) ?? [];
      expect(asked.length, `${count} ${population} ${child.id}`).toBeGreaterThan(0);
      const worst = child.settled
        ? (asked[0] ?? Infinity)
        : Math.max(...gaps(asked), asked[0] ?? 0);
      expect(worst, `${count} ${population} ${child.id}`).toBeLessThanOrEqual(
        bound(child, children.length, 4 * MINUTE),
      );
    }
  }
});

test("a. any child that answers when asked alone is asked within the bound, whatever the others do", () => {
  for (const seed of seeds) {
    const children = generate(seed, 8 + (seed % 5) * 9, 0);
    const trace = simulate(children, 20 * MINUTE, [7 * MINUTE + 3000]);
    for (const child of children) {
      if (child.behaviour.kind !== "healthy" || !child.paired || trace.ended.has(child.id))
        continue;
      const asked = trace.asked.get(child.id) ?? [];
      expect(asked.length, `${seed} ${child.id}`).toBeGreaterThan(0);
      const worst = Math.max(...gaps(asked), asked[0] ?? 0);
      expect(worst, `seed ${seed} ${child.id}`).toBeLessThanOrEqual(
        bound(child, children.length, 20 * MINUTE),
      );
    }
  }
});

test("b. a child whose call failed is never batched with others until it has answered alone", () => {
  for (const seed of seeds) {
    const children = generate(seed, 30, 0);
    const trace = simulate(children, 15 * MINUTE, [5 * MINUTE]);
    expect(trace.breaches, `seed ${seed}`).toEqual([]);
  }
});

test("c. each failing child backs off on its own to the 30 s cap, and a machine's calls stay bounded", () => {
  for (const seed of seeds) {
    const children = generate(seed, 40, 0);
    const trace = simulate(children, 30 * MINUTE);
    for (const child of children) {
      if (!child.paired || child.behaviour.kind !== "fails") continue;
      const late = (trace.asked.get(child.id) ?? []).filter((at) => at >= 10 * MINUTE);
      // Twice a minute at the cap, whatever else answered meanwhile.
      for (const gap of gaps(late))
        expect(gap, `seed ${seed} ${child.id}`).toBeGreaterThanOrEqual(30_000);
    }
    // Over the last ten minutes, whatever the mix: never more than a call per poll for each
    // working child and one per 10 s for each settled one, and never past 16 calls a turn.
    const working = children.filter((child) => child.paired && !child.settled).length;
    const settled = children.filter((child) => child.paired && child.settled).length;
    const perMinute = Math.min(16 * 60, working * 60 + settled * 6);
    const late = trace.calls.filter((call) => call.at >= 20 * MINUTE).length;
    expect(late / 10, `seed ${seed}`).toBeLessThanOrEqual(perMinute);
  }
});

test("c. with only healthy and always-failing children, calls follow the batching bound", () => {
  for (const seed of seeds) {
    const children = generate(seed, 40, 0).map((child) =>
      Object.assign({}, child, {
        behaviour: { kind: child.behaviour.kind === "fails" ? "fails" : "healthy" } as Behaviour,
      }),
    );
    const trace = simulate(children, 30 * MINUTE);
    const paired = children.filter((child) => child.paired);
    const working = paired.filter((child) => !child.settled && child.behaviour.kind === "healthy");
    const settled = paired.filter((child) => child.settled).length;
    const failing = paired.filter((child) => child.behaviour.kind === "fails").length;
    // Healthy working children share calls of 16 every poll, settled ones are asked at most
    // every 10 s, and each child failing alone twice a minute at the cap. A failing working
    // child takes down the first call it shares once; the others are asked alone at once.
    const perMinute = Math.ceil(working.length / 16) * 60 + settled * 6 + failing * 2;
    const late = trace.calls.filter((call) => call.at >= 20 * MINUTE).length;
    expect(late / 10, `seed ${seed}`).toBeLessThanOrEqual(perMinute);
  }
});

test("d. no child leaves tracking without an answered check after its 24 h mark; unpaired is no answer", () => {
  for (const seed of seeds) {
    const children = generate(seed, 30, 0);
    const trace = simulate(children, 20 * MINUTE, [9 * MINUTE]);
    for (const [id, sent] of trace.endedBy) {
      const child = children.find((entry) => entry.id === id);
      if (!child?.settled || child.settledAt === null) throw new Error(`${id} ended unsettled`);
      // The read that ended it went out at or after its mark, whenever its answer came.
      expect(sent - child.settledAt, `seed ${seed} ${id}`).toBeGreaterThanOrEqual(
        RECHECK_WINDOW_MS,
      );
      expect(child.paired, `seed ${seed} ${id}`).toBe(true);
      // Either a view came back, or the machine said it doesn't hold it: an answer either way.
      expect(["healthy", "not_found", "flapping", "poisons", "delayed"], `${seed} ${id}`).toContain(
        child.behaviour.kind,
      );
    }
    for (const child of children.filter((entry) => !entry.paired)) {
      expect(trace.asked.get(child.id), `seed ${seed} ${child.id}`).toBeUndefined();
      expect(trace.ended.has(child.id)).toBe(false);
    }
  }
});

test("d. with replies arriving long after their reads, only a read sent at or after the 24 h mark ends tracking", () => {
  for (const seed of seeds) {
    const next = random(seed * 31);
    // Settled children whose marks fall during the run; most answer only seconds to a minute
    // after each read, so many replies to reads sent before a mark arrive after it.
    const children = generate(seed, 40, 0, "settled", 0.3).map((child) =>
      Object.assign({}, child, {
        settledAt: -RECHECK_WINDOW_MS + Math.floor(next() * 10 * MINUTE),
        unconfirmed: false,
        behaviour:
          next() < 0.7
            ? ({ kind: "delayed", ms: 2_000 + Math.floor(next() * 60_000) } as Behaviour)
            : child.behaviour,
      }),
    );
    const trace = simulate(children, 20 * MINUTE, [12 * MINUTE + 4000]);
    expect(trace.endedBy.size, `seed ${seed}`).toBeGreaterThan(0);
    for (const [id, sent] of trace.endedBy) {
      const child = children.find((entry) => entry.id === id);
      expect(sent - (child?.settledAt ?? Infinity), `seed ${seed} ${id}`).toBeGreaterThanOrEqual(
        RECHECK_WINDOW_MS,
      );
    }
    // And every child whose mark passed early enough was let go of, by such a read.
    for (const child of children)
      if (
        child.paired &&
        child.behaviour.kind === "delayed" &&
        (child.settledAt ?? 0) < -2 * MINUTE
      )
        expect(trace.endedBy.has(child.id), `seed ${seed} ${child.id}`).toBe(true);
  }
});

test("an answer counts as of when its read went out: a reply to a read sent before the mark is an ordinary re-check", () => {
  const config = defaultScheduleConfig(POLL, 0);
  const settledAt = 0;
  const mark = settledAt + RECHECK_WINDOW_MS;
  const child: ScheduleChild = {
    id: "c",
    settled: true,
    settledAt,
    unconfirmed: false,
    paired: true,
  };
  const records = new Map<string, ChildRecord>();
  const answered: CallOutcome = { kind: "answered" };
  // Sent a second before the mark, answered a minute after it.
  const late = foldCall(
    records,
    [child],
    ["c"],
    answered,
    { sent: mark - 1000, now: mark + 60_000 },
    config,
  );
  expect(late.ended).toEqual([]);
  // Its next check is due at once (past the mark, from when that read went out), and ends it.
  const due = nextDue([child], late.records, mark + 60_000, config) ?? Infinity;
  expect(due).toBeLessThanOrEqual(mark + 60_000);
  // Sent at the mark, however late its answer: the final check.
  const final = foldCall(
    records,
    [child],
    ["c"],
    answered,
    { sent: mark, now: mark + 60_000 },
    config,
  );
  expect(final.ended).toEqual(["c"]);
  // The machine saying it doesn't hold it counts the same way.
  const refused: CallOutcome = { kind: "not_found" };
  expect(
    foldCall(records, [child], ["c"], refused, { sent: mark - 1, now: mark + 5 }, config).ended,
  ).toEqual([]);
});

test("c. once its machine is back, every child whose reads failed in the outage is read promptly, whatever late replies arrive meanwhile", () => {
  for (const seed of seeds) {
    const next = random(seed * 17);
    const children: SimChild[] = Array.from({ length: 40 }, (_, index) => ({
      id: `w-${String(index).padStart(2, "0")}`,
      settled: false,
      settledAt: null,
      unconfirmed: false,
      paired: true,
      behaviour: { kind: "healthy" },
    }));
    const outage = { from: 2 * MINUTE, to: 2 * MINUTE + 38_000 + Math.floor(next() * 10_000) };
    // Descriptions sent before the outage whose replies arrive all through it: they prove the
    // machine was up when they were sent, nothing of the outage.
    const others = Array.from({ length: 60 }, () => {
      const sent = MINUTE + Math.floor(next() * MINUTE);
      return { sent, now: outage.from + Math.floor(next() * (outage.to - outage.from)) };
    }).filter((call) => call.now > call.sent);
    // Then a description sent once the outage is over gets through: the machine is back.
    const back = outage.to + 2 * POLL;
    others.push({ sent: outage.to + POLL, now: back });
    const trace = simulate(children, 6 * MINUTE, [], 0, outage, others);
    const turns = Math.ceil(children.length / 16) + 2;
    let checked = 0;
    for (const child of children) {
      if (!trace.failedAt.get(child.id)?.some((at) => at >= outage.from && at < outage.to))
        continue;
      checked++;
      const after = (trace.asked.get(child.id) ?? []).find((at) => at > back);
      // Read within a few turns of the machine answering again, not at the end of a 30 s wait.
      expect((after ?? Infinity) - back, `seed ${seed} ${child.id}`).toBeLessThanOrEqual(
        turns * POLL,
      );
    }
    expect(checked, `seed ${seed}`).toBeGreaterThan(0);
  }
});

test("reachability evidence is as of when the call that got through was sent", () => {
  const config = defaultScheduleConfig(POLL, 0);
  // A call sent at 10 s comes back at 100 s: the machine was known up at 10 s, not 100 s.
  const heard = heardFrom(undefined, { sent: 10_000, now: 100_000 });
  expect(machineDown(heard, 100_000, config)).toBe(true);
  expect(machineDown(heard, 11_000, config)).toBe(false);
  // Evidence only moves forward.
  expect(heardFrom(heard, { sent: 5_000, now: 120_000 })).toBe(heard);
});

test("e. an unconfirmed stop, or a child past its window, keeps to the fast pace", () => {
  const start = 0;
  const children: SimChild[] = [
    {
      id: "stopped",
      settled: true,
      settledAt: start - 1000,
      unconfirmed: true,
      paired: true,
      behaviour: { kind: "healthy" },
    },
    {
      id: "expired",
      settled: true,
      settledAt: start - RECHECK_WINDOW_MS - 1000,
      unconfirmed: false,
      paired: true,
      behaviour: { kind: "fails" },
    },
    {
      id: "old",
      settled: true,
      settledAt: start - 5 * 60 * MINUTE,
      unconfirmed: false,
      paired: true,
      behaviour: { kind: "healthy" },
    },
    ...Array.from({ length: 20 }, (_, index): SimChild => ({
      id: `noise-${index}`,
      settled: false,
      settledAt: null,
      unconfirmed: false,
      paired: true,
      behaviour: { kind: index % 3 === 0 ? "fails" : "healthy" },
    })),
  ];
  const trace = simulate(children, 10 * MINUTE);
  const fast = RECHECK_POLLS * POLL;
  // The unconfirmed stop is read every 10 s at worst, failing neighbours or not.
  expect(Math.max(...gaps(trace.asked.get("stopped") ?? []))).toBeLessThanOrEqual(
    fast + (Math.ceil(children.length / 16) + 1) * POLL,
  );
  // The expired child failing every read backs off as any failing child does, and never ends.
  expect(trace.ended.has("expired")).toBe(false);
  expect(trace.breaches).toEqual([]);
});

test("a restart mid-run reads every saved child again within the bound of start", () => {
  const children = generate(99, 50, 0);
  const restartAt = 6 * MINUTE;
  const trace = simulate(children, 8 * MINUTE, [restartAt]);
  for (const child of children) {
    if (child.behaviour.kind !== "healthy" || !child.paired || trace.ended.has(child.id)) continue;
    const after = (trace.asked.get(child.id) ?? []).find((at) => at >= restartAt);
    expect(after, child.id).toBeDefined();
    expect((after ?? Infinity) - restartAt, child.id).toBeLessThanOrEqual(
      RECHECK_POLLS * POLL + (Math.ceil(50 / 16) + 1) * POLL + TIMEOUT_MS + POLL,
    );
  }
});

test("for any tracked set, something owed always has a time: nextDue is defined", () => {
  for (const seed of seeds) {
    for (const population of ["mixed", "working", "settled"] as const) {
      // Every child unpaired, every one paired, and the generated mix.
      for (const paired of [undefined, true, false]) {
        const children = generate(seed, 40, 0, population).map((child) =>
          paired === undefined ? child : Object.assign({}, child, { paired }),
        );
        const config = defaultScheduleConfig(POLL, 0);
        const at = nextDue(children, new Map(), 0, config);
        // Every child here is owed something: a read, or a look at its pairing and its 24 h mark.
        expect(at, `seed ${seed} ${population} ${String(paired)}`).toBeDefined();
        // And never further than the slowest interval away.
        expect(at ?? Infinity).toBeLessThanOrEqual(RECHECK_SLOWEST_POLLS * POLL);
      }
    }
  }
});
