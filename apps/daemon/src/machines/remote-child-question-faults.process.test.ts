import { expect, it } from "vitest";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { ThreadId } from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import { REMOTE_STOP, stopBound } from "../liveness/stop.ts";
import type { Store } from "../store.ts";
import { ChildRow } from "./child-ledger.ts";
import { questionFacts, questionFate } from "./child-question.ts";
import type { MachineChildren } from "./children.ts";
import {
  asks,
  children,
  ids,
  live,
  notSent,
  parentView,
  parentWithChildren,
  silentChild,
  stopTracking,
  type Fixture,
} from "./remote-child-test-support.ts";

/*
 * The person's question about a child that lost contact (ADR 0153), with one write failing (a
 * busy store) in the middle of each way that question ends or changes. Whatever fails, polling
 * leaves no question open for a child that isn't lost, and never a parent held by a question
 * nobody can answer. A real parent engine and store; the other machine played in memory.
 */

const nothing = () => {};
/** What the person's question says. */
const titleOf = (ask: { request: object }) =>
  "title" in ask.request && typeof ask.request.title === "string" ? ask.request.title : "";

/**
 * Writes that can fail: write statements in the store's transactions, and the engine's writes to
 * the parent. When the one failure has run its course (its transaction rolled back, or at once
 * outside one) and before anything else runs, `check` reads the store as it is then.
 */
function faulty(f: Fixture) {
  let calls = 0;
  let failAt = Number.POSITIVE_INFINITY;
  /** Transactions open through this store. */
  let depth = 0;
  let unwinding = false;
  let check: () => void = nothing;
  let checked = false;
  const inspect = () => {
    checked = true;
    check();
  };
  const hit = () => {
    calls++;
    if (calls !== failAt) return;
    // Outside a transaction nothing rolls back: what is stored now is what the failure leaves.
    if (depth === 0) inspect();
    else unwinding = true;
    throw new Error("database is locked");
  };
  const wrap = <T extends object>(target: T, keys: ReadonlySet<PropertyKey>): T =>
    new Proxy(target, {
      get(on, key) {
        const value: unknown = Reflect.get(on, key, on);
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(on);
        if (!keys.has(key)) return bound;
        return (...args: unknown[]) => {
          hit();
          return bound(...args);
        };
      },
    });
  // A write statement in one of the store's transactions; reads never fail here.
  const writes = (db: DatabaseSync): DatabaseSync =>
    new Proxy(db, {
      get(on, key) {
        const value: unknown = Reflect.get(on, key, on);
        if (typeof value !== "function") return value;
        if (key === "prepare") return (sql: string) => wrap(on.prepare(sql), new Set(["run"]));
        return (value as (...args: unknown[]) => unknown).bind(on);
      },
    });
  const store: Store = new Proxy(f.store, {
    get(on, key) {
      const value: unknown = Reflect.get(on, key, on);
      if (key === "atomic")
        return <T>(run: (db: DatabaseSync) => T) => {
          depth++;
          try {
            return on.atomic((db) => run(writes(db)));
          } finally {
            depth--;
            // The outermost transaction around the failure has ended, committed or rolled back.
            if (depth === 0 && unwinding) {
              unwinding = false;
              inspect();
            }
          }
        };
      return typeof value === "function" ? (value as () => unknown).bind(on) : value;
    },
  });
  const engine: Engine = wrap(
    f.engine,
    new Set(["machineChild", "openHostApproval", "resolveHostApproval"]),
  );
  return {
    store,
    engine,
    /** Counts writes from now; the `at`-th fails, once. */
    arm(at: number) {
      calls = 0;
      failAt = at;
    },
    /** No more failures: what is checked afterwards reads the store as it is. */
    disarm() {
      failAt = Number.POSITIVE_INFINITY;
    },
    /** What reads the store the moment the failure has run its course. */
    onFailure(run: () => void) {
      check = run;
      checked = false;
    },
    /** Whether the failure happened, and was checked. */
    get checked() {
      return checked;
    },
    get calls() {
      return calls;
    },
  };
}

type Lost = Awaited<ReturnType<typeof silentChild>>;
interface Transition {
  name: string;
  /** Starts before its lease runs out, instead of with its question already open. */
  lapsing?: boolean;
  /** What happens to the child, through the faulty daemon. */
  run(lost: Lost, on: MachineChildren): Promise<void> | void;
}

const transitions: Transition[] = [
  // The lease runs out while polling: the question opens with the child's hold and row.
  { name: "its lease runs out", lapsing: true, run: () => {} },
  {
    name: "its machine answers again",
    run: ({ rijan }) => {
      rijan.silent = false;
    },
  },
  {
    name: "it settles while lost contact",
    run: ({ rijan, id }) => {
      rijan.silent = false;
      rijan.views.set(id, {
        ...notSent(id),
        state: "done",
        status: { state: "done" },
        result: "Done there.",
        truncated: false,
      });
    },
  },
  { name: "it is stopped", run: ({ id }, on) => void on.stop(id) },
  {
    name: "the person stops tracking it",
    run: ({ f, parent }, on) => {
      const [ask] = asks(f, parent);
      if (ask) stopTracking(on, ask.id);
    },
  },
  {
    name: "its machine is unpaired",
    run: ({ rijan }) => {
      rijan.paired = false;
    },
  },
];

/** Lets polling run past a whole stop and the slowest retry, a poll every ten seconds. */
async function settle(lost: Lost, on: MachineChildren) {
  const until = lost.f.clock.now() + stopBound(REMOTE_STOP) + 120_000;
  while (lost.f.clock.now() < until)
    // A poll the one failure stops is simply polled again.
    await lost.at(lost.f.clock.now() + 10_000, on).catch(() => undefined);
}

/**
 * Every open question about the child can be answered: the child is lost (contact or pairing)
 * and offers it as its request, and there is at most one.
 */
function answerable(lost: Lost, on: MachineChildren) {
  const open = asks(lost.f, lost.parent);
  expect(open.length).toBeLessThanOrEqual(1);
  const [ask] = open;
  if (!ask) return;
  const view = on.watched(lost.id as ThreadId)?.view;
  expect(view?.state).toBe("needs_you");
  expect(view?.needs?.map((need) => need.interactionId)).toContain(ask.id);
}

/**
 * What the store says at one instant agrees with itself: each change to the question and the
 * child state it goes with are both there or neither is. Every open question is the one its child
 * points at, and its child is still one to ask about; an unpaired child has its pairing question
 * and a child that lost contact its own;
 * and while a question is open its parent holds the child, whose row is live.
 */
function inconsistencies(lost: Lost): string[] {
  const { f, parent } = lost;
  const problems: string[] = [];
  const rows = f.store
    .atomic((db) => db.prepare("SELECT * FROM machine_children").all())
    .map((row) => ChildRow.parse(row));
  const open = asks(f, parent);
  for (const ask of open) {
    const row = rows.find((candidate) => candidate.lost_ask === ask.id);
    if (!row) problems.push(`question open that no child points at`);
    else if (questionFate(questionFacts(row)) === "close")
      problems.push(
        `question open for a child no longer lost: ${JSON.stringify(questionFacts(row))}`,
      );
  }
  for (const row of rows)
    if (
      row.settled === 0 &&
      row.lost_at !== null &&
      !open.some((ask) => ask.id === row.lost_ask && !titleOf(ask).startsWith("Lost contact"))
    )
      problems.push("unpaired child without its pairing question");
  // Its parent's session is live throughout here, so nothing else closes its question.
  for (const row of rows)
    if (
      questionFate(questionFacts(row)) === "keep" &&
      row.settled === 0 &&
      row.lost_at === null &&
      !open.some((ask) => ask.id === row.lost_ask && titleOf(ask).startsWith("Lost contact"))
    )
      problems.push("child lost contact without its question");
  if (open.length > 0) {
    const view = parentView(f, parent);
    if (!view.holds.some((hold) => hold.status === "running"))
      problems.push("question open while the parent's hold isn't running");
    if (view.rows[0]?.live !== true)
      problems.push("question open while the child's row reads finished");
  }
  return problems;
}

/**
 * A working child whose machine stops answering, watched from the start by a daemon whose writes
 * can fail, its lease a minute: the question opens as it lapses.
 */
async function lapsingWithFaults() {
  const fixture = await parentWithChildren(1);
  fixture.ledger.close();
  const { f, parent, rijan } = fixture;
  const [id] = ids;
  if (!id) throw new Error("no child");
  const faults = faulty(f);
  const on = children(f, rijan, 60_000, () => faults.engine, faults.store);
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await fixture.at(f.clock.now() + 1_000, on);
  await f.complete(parent.threadId, "Delegated the review.");
  rijan.silent = true;
  await fixture.at(f.clock.now() + 1_000, on);
  expect(asks(f, parent)).toEqual([]);
  return { lost: { ...fixture, id, quiet: f.clock.now() }, faults, on };
}

/** A fresh child that lost contact, watched by a daemon whose writes can fail. */
async function lostWithFaults() {
  const lost = await silentChild();
  lost.ledger.close();
  const faults = faulty(lost.f);
  const on = children(lost.f, lost.rijan, undefined, () => faults.engine, faults.store);
  // Read once as this daemon starts: its question is already open.
  await lost.at(lost.f.clock.now() + 1_000, on);
  expect(asks(lost.f, lost.parent)).toHaveLength(1);
  return { lost, faults, on };
}

it("a Stop whose closing of the question fails still ends with no question and a parent let go", async () => {
  const { lost, faults, on } = await lostWithFaults();
  // The cancel is recorded, but closing the question fails.
  let failed = false;
  const engine = new Proxy(lost.f.engine, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === "resolveHostApproval" && !failed)
        return () => {
          failed = true;
          throw new Error("database is locked");
        };
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  on.close();
  const stopping = children(lost.f, lost.rijan, undefined, () => engine, faults.store);
  try {
    stopping.stop(lost.id);
  } catch {
    // The person's Stop reported the failure.
  }
  expect(failed).toBe(true);
  // Before any poll: the stop and the question's closing are both there or neither is.
  expect(inconsistencies(lost)).toEqual([]);
  // Stopped again later: already under way, so nothing new.
  stopping.stop(lost.id);
  await settle(lost, stopping);

  expect(asks(lost.f, lost.parent)).toEqual([]);
  expect(stopping.child(lost.id)?.settled).toBe(true);
  expect(live).not.toContain(parentView(lost.f, lost.parent).status.state);
  stopping.close();
});

it.each(transitions.map((transition) => [transition.name, transition] as const))(
  "when %s with any one write failing, no question is left that can't be answered",
  async (_name, transition) => {
    const start = () => (transition.lapsing ? lapsingWithFaults() : lostWithFaults());
    // How many writes the transition makes, run once without a failure.
    const dry = await start();
    dry.faults.arm(Number.POSITIVE_INFINITY);
    await transition.run(dry.lost, dry.on);
    await settle(dry.lost, dry.on);
    answerable(dry.lost, dry.on);
    // Lapsing, the question did open.
    if (transition.lapsing) expect(asks(dry.lost.f, dry.lost.parent)).toHaveLength(1);
    const writes = dry.faults.calls;
    dry.on.close();
    expect(writes).toBeGreaterThan(0);

    // Each of its writes in turn is the one that fails.
    for (let at = 1; at <= writes; at++) {
      const { lost, faults, on } = await start();
      // The moment the failure has run its course, before any other write or poll: both
      // changes or neither.
      let atFailure: string[] = [];
      faults.onFailure(() => (atFailure = inconsistencies(lost)));
      faults.arm(at);
      try {
        await transition.run(lost, on);
      } catch {
        // The write that failed surfaced here; polling carries on.
      }
      await settle(lost, on);
      faults.disarm();
      expect({ at, checked: faults.checked, atFailure }).toEqual({
        at,
        checked: true,
        atFailure: [],
      });
      answerable(lost, on);
      expect(inconsistencies(lost)).toEqual([]);
      on.close();
    }
  },
  // About two dozen fresh daemons each, a quarter of a second apiece.
  25_000,
);
