import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentId, ThreadId, type MachineMessage, type MachineThreadView } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { MachineChildren } from "./children.ts";
import { RECHECK_PER_MACHINE, RECHECK_POLLS } from "./child-recheck.ts";
import { RequestMirror } from "./mirror.ts";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const parent = ThreadId.parse("parent");
const POLL_MS = 50;
const HOUR = 60 * 60 * 1000;
const working: Partial<MachineThreadView> = {
  state: "working",
  status: { state: "working", agents: 1 },
};
const done = (result: string, elapsedSeconds = 5): Partial<MachineThreadView> => ({
  state: "done",
  status: { state: "done" },
  result,
  elapsedSeconds,
});
const message = (requestId: string): MachineMessage => ({
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
function machine(home = mkdtempSync(join(tmpdir(), "ace-machine-reconcile-"))) {
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
  const answers = { resend: async (): Promise<"taken" | "decided"> => "taken" };
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
      return answers.resend();
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
    isDescendant: () => false,
    log: () => {},
  });
  const add = (id: string) => {
    const threadId = ThreadId.parse(id);
    children.add({
      id: threadId,
      requestKey: `parent:${id}`,
      parentThreadId: parent,
      parentAgentId: AgentId.parse("agent"),
      machine: "studio",
      role: `Task-${id}`,
      provider: "claude",
      title: `Task-${id}`,
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
  };
}

it("a message its machine has not answered for keeps the child open, even across a restart, until it is answered", async () => {
  const first = machine();
  const id = first.add("child");
  first.report(id, done("First pass done."));
  await first.fire();
  expect(first.state(id)).toBe("done");

  // The message leaves, and the reply never comes back (a timeout, or the caller stops).
  first.children.send(id, message("second-pass"));
  first.children.close();
  const restarted = machine(first.home);
  restarted.report(id, done("First pass done."));
  restarted.answers.resend = async () => {
    throw new Error("Studio is unreachable");
  };
  // Its machine still reports the earlier result: that can't settle it while the message is open.
  await restarted.fire();
  await restarted.fire();
  expect(restarted.state(id)).toBe("working");
  expect(restarted.resent).toEqual(["second-pass", "second-pass"]);
  expect(restarted.delivered).toEqual([]);

  // Sent again under the same id, the machine answers for it: the work runs and settles.
  restarted.answers.resend = async () => "taken";
  restarted.report(id, working);
  await restarted.fire();
  expect(restarted.state(id)).toBe("working");
  restarted.report(id, done("Second pass done.", 9));
  await restarted.fire();
  expect(restarted.state(id)).toBe("done");
  expect(restarted.delivered).toEqual([expect.stringContaining("Second pass done.")]);
});

it("an answer the store could not save is not lost: the message is sent again and the child settles", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, working);
  await h.fire();
  const release = h.children.send(id, message("follow-up"));
  h.faults.failNextWrite = true;
  release("taken");

  // The answer did not stick: the child stays open, and the next poll asks again.
  h.report(id, done("Follow-up done."));
  await h.fire();
  expect(h.resent).toEqual(["follow-up"]);
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toEqual([expect.stringContaining("Follow-up done.")]);
});

it("an unchanged result after a follow-up that never ran is not repeated, and polling goes quiet", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  expect(h.delivered).toHaveLength(1);
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);

  // A follow-up its machine refused: the child reopens, then reads the same result again.
  h.children.send(id, message("refused"))("refused");
  await h.fire();
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toHaveLength(1);
  // Back at the slow re-check pace, and after the re-check window, no polling at all.
  expect(h.timers.map((timer) => timer.ms)).toEqual([POLL_MS * RECHECK_POLLS]);
  h.clock.now += 25 * HOUR;
  await h.fire();
  expect(h.timers).toEqual([]);
});

it("with more settled children than one re-check asks about, every one is checked in turn", async () => {
  const h = machine();
  const ids = Array.from({ length: RECHECK_PER_MACHINE + 1 }, (_, index) =>
    h.add(`child-${index}`),
  );
  for (const id of ids) h.report(id, done(`Result ${id}`));
  await h.fire();
  for (const id of ids) expect(h.state(id), id).toBe("done");
  h.asked.length = 0;

  // The first turn asks about at most a batch; the child it left out goes next, and work the
  // person there gave it is noticed then.
  await h.fire();
  const first = new Set(h.asked.flat());
  expect(first.size).toBe(RECHECK_PER_MACHINE);
  const left = ids.find((id) => !first.has(id));
  if (!left) throw new Error("Every child was asked about at once");
  h.report(left, working);
  await h.fire();
  expect(h.asked.at(-1)).toContain(left);
  expect(h.state(left)).toBe("working");
  expect(h.asked.every((batch) => batch.length <= RECHECK_PER_MACHINE)).toBe(true);
});

it("a status reply read before a retried message was taken can't settle the child when saving the take fails", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("First pass done."));
  await h.fire();
  expect(h.delivered).toHaveLength(1);
  // A follow-up whose reply was lost: it is sent again on the next poll.
  h.children.send(id, message("second"))(undefined);

  // That poll's status reply reads the old result and is held back; meanwhile the machine takes
  // the message again, but the write that would fence that old reply fails.
  const held = h.holdNextStatus();
  h.faults.failSql = "generation=generation+1";
  await h.fire();
  expect(h.resent).toEqual(["second"]);
  await held.release();
  expect(h.state(id)).toBe("working");
  expect(h.delivered).toHaveLength(1);

  // Taken again with the store healthy, the work runs and its own result reaches the parent.
  h.report(id, working);
  await h.fire();
  await h.fire();
  h.report(id, done("Second pass done.", 9));
  await h.fire();
  expect(h.state(id)).toBe("done");
  expect(h.delivered).toEqual([
    expect.stringContaining("First pass done."),
    expect.stringContaining("Second pass done."),
  ]);
});
