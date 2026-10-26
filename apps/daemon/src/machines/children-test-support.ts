/* A caller's children on other machines over a real store, the other machines played in memory. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { AgentId, ThreadId, type MachineMessage, type MachineThreadView } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { MachineChildren } from "./children.ts";
import { RequestMirror } from "./mirror.ts";
import type { ResendAnswer } from "./child-messages.ts";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

export const parent = ThreadId.parse("parent");
export const POLL_MS = 50;
export const HOUR = 60 * 60 * 1000;
export const working: Partial<MachineThreadView> = {
  state: "working",
  status: { state: "working", agents: 1 },
};
export const done = (result: string, elapsedSeconds = 5): Partial<MachineThreadView> => ({
  state: "done",
  status: { state: "done" },
  result,
  elapsedSeconds,
});
export const message = (requestId: string): MachineMessage => ({
  requestId,
  text: "Do a second pass",
  delivery: "queue",
});

/**
 * Children on another machine, played by `report` (what its status says) and `resendAnswer`
 * (how it answers a message sent again). Timers queue up and run only when the test fires them;
 * `failNextWrite` makes the next storage transaction fail, as a store busy past its timeout, and
 * `failSql` the next statement whose SQL contains it. `holdNextStatus` keeps the next status
 * reply (read now) from arriving until the test releases it.
 */
export function machine(home = mkdtempSync(join(tmpdir(), "ace-machine-reconcile-"))) {
  if (!homes.includes(home)) homes.push(home);
  const real = new Store(join(home, "events.sqlite"));
  stores.push(real);
  const faults: { failNextWrite: boolean; failSql?: string | undefined } = {
    failNextWrite: false,
  };
  const failing = (db: import("node:sqlite").DatabaseSync) =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (faults.failSql && sql.includes(faults.failSql)) {
              faults.failSql = undefined;
              throw new Error("database is locked");
            }
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const store = new Proxy(real, {
    get(target, prop) {
      if (prop === "atomic" && faults.failNextWrite) {
        faults.failNextWrite = false;
        return () => {
          throw new Error("database is locked");
        };
      }
      if (prop === "atomic")
        return <T>(run: (db: import("node:sqlite").DatabaseSync) => T) =>
          target.atomic((db) => run(faults.failSql ? failing(db) : db));
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const views = new Map<string, MachineThreadView>();
  const asked: string[][] = [];
  const resent: string[] = [];
  const delivered: string[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const clock = { now: 1_000_000 };
  const holds: { next?: Promise<void> | undefined } = {};
  const holdNextStatus = () => {
    let release: (() => void) | undefined;
    holds.next = new Promise((resolve) => {
      release = () => resolve();
    });
    return {
      async release() {
        release?.();
        await new Promise((resolve) => setImmediate(resolve));
      },
    };
  };
  /** `error` makes every status call fail with it, as a machine refusing or unreachable. */
  const reads: { error?: unknown } = {};
  const answers = {
    resend: async (_machine: string): Promise<ResendAnswer> => "taken",
  };
  /**
   * Changes to the caller's pairings: each machine is paired as `device-<machine>` unless set
   * here, to another device (linked again) or undefined (the pairing was removed).
   */
  const pairings = new Map<string, string | undefined>();
  const device = (host: string) => (pairings.has(host) ? pairings.get(host) : `device-${host}`);
  /** Local delegation edges, child to parent, as the journal reads them. */
  const edges = new Map<string, ThreadId>();
  const children = new MachineChildren({
    store,
    engine: () => undefined,
    now: () => clock.now,
    schedule: (ms, run) => {
      const timer = { ms, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    pollMs: POLL_MS,
    status: async (_machine, _parent, ids) => {
      asked.push([...ids]);
      if (reads.error) throw reads.error;
      const read = ids.flatMap((id) => {
        const view = views.get(id);
        return view ? [view] : [];
      });
      const held = holds.next;
      holds.next = undefined;
      return held ? held.then(() => read) : read;
    },
    resend: async (_machine, _parent, _child, sent) => {
      resent.push(sent.requestId);
      return answers.resend(_machine);
    },
    mirror: new RequestMirror({
      store,
      engine: () => undefined,
      respond: async () => {},
      log: () => {},
    }),
    label: () => "Studio",
    deliver: (_parent, _key, text) => {
      delivered.push(text);
    },
    waiting: () => false,
    isDescendant: (child, ancestor) => {
      for (let at = edges.get(child); at; at = edges.get(at)) if (at === ancestor) return true;
      return false;
    },
    descendants: (thread) => {
      const found: ThreadId[] = [];
      const visit = (id: ThreadId) => {
        for (const [child, of] of edges)
          if (of === id) {
            found.push(ThreadId.parse(child));
            visit(ThreadId.parse(child));
          }
      };
      visit(thread);
      return found;
    },
    device,
    log: () => {},
  });
  const add = (id: string, host = "studio", from: ThreadId = parent) => {
    const threadId = ThreadId.parse(id);
    children.add({
      id: threadId,
      requestKey: `${from}:${id}`,
      parentThreadId: from,
      parentAgentId: AgentId.parse("agent"),
      machine: host,
      role: `Task-${id}`,
      provider: "claude",
      title: `Task-${id}`,
      device: device(host),
    });
    return threadId;
  };
  const report = (id: string, next: Partial<MachineThreadView>) =>
    views.set(id, {
      threadId: ThreadId.parse(id),
      state: "working",
      title: `Task-${id}`,
      elapsedSeconds: 1,
      status: { state: "working", agents: 1 },
      requests: [],
      ...next,
    });
  /** Runs the next queued timer and waits for the poll it starts to finish. */
  const fire = async () => {
    const timer = timers.shift();
    if (!timer) throw new Error("No poll is scheduled");
    timer.run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const state = (id: string) => children.watched(ThreadId.parse(id))?.view.state;
  return {
    home,
    children,
    add,
    report,
    fire,
    state,
    asked,
    resent,
    delivered,
    timers,
    clock,
    answers,
    faults,
    holdNextStatus,
    pairings,
    edges,
    reads,
  };
}
