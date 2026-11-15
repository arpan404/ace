import { expect, it } from "vitest";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { ThreadId } from "@ace/protocol";
import type { Engine } from "../engine/index.ts";
import { REMOTE_STOP, stopBound } from "../liveness/stop.ts";
import type { Store } from "../store.ts";
import type { MachineChildren } from "./children.ts";
import {
  asks,
  children,
  live,
  notSent,
  parentView,
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

/** Writes that can fail: write statements in the store's transactions, and the engine's writes to the parent. */
function faulty(f: Fixture) {
  let calls = 0;
  let failAt = Number.POSITIVE_INFINITY;
  const hit = () => {
    calls++;
    if (calls === failAt) throw new Error("database is locked");
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
        return <T>(run: (db: DatabaseSync) => T) => on.atomic((db) => run(writes(db)));
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
    get calls() {
      return calls;
    },
  };
}

type Lost = Awaited<ReturnType<typeof silentChild>>;
interface Transition {
  name: string;
  /** What happens to the child, through the faulty daemon. */
  run(lost: Lost, on: MachineChildren): Promise<void> | void;
}

const transitions: Transition[] = [
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
    // How many writes the transition makes, run once without a failure.
    const dry = await lostWithFaults();
    dry.faults.arm(Number.POSITIVE_INFINITY);
    await transition.run(dry.lost, dry.on);
    await settle(dry.lost, dry.on);
    answerable(dry.lost, dry.on);
    const writes = dry.faults.calls;
    dry.on.close();
    expect(writes).toBeGreaterThan(0);

    // Each of its writes in turn is the one that fails.
    for (let at = 1; at <= writes; at++) {
      const { lost, faults, on } = await lostWithFaults();
      faults.arm(at);
      try {
        await transition.run(lost, on);
      } catch {
        // The write that failed surfaced here; polling carries on.
      }
      await settle(lost, on);
      faults.disarm();
      answerable(lost, on);
      on.close();
    }
  },
  // About two dozen fresh daemons each, a quarter of a second apiece.
  20_000,
);
