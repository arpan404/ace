import { afterEach, expect, test, vi } from "vitest";
import { longHistory, ScenarioPlayer } from "@ace/fake-daemon";
import { CommandPayload, ThreadId } from "@ace/protocol";
import type { DiagnosticEvent, Scheduler } from "@ace/client";
import { RemoteClient, type PortLike, type WorkerLoss } from "./index.ts";
import { TabMessage } from "./wire.ts";
import { cleanups, world } from "./worker-test-support.ts";

const noop = () => {};

afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** The tab's own timers (pings, deadlines, respawn backoff) on manual time. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const scheduler: Scheduler = {
    set(delay, run) {
      const timer = { at: now + delay, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { scheduler, advance, now: () => now };
}

type Answer = (message: TabMessage, reply: (data: unknown) => void) => void;

/** A worker on the far side of a fake port: silent unless `answer` says how to reply. */
function fakeWorker(answer?: Answer) {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const received: TabMessage[] = [];
  const reply = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  const port: PortLike = {
    postMessage(message: unknown) {
      const parsed = TabMessage.parse(message);
      received.push(parsed);
      answer?.(parsed, reply);
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  return { port, received, reply };
}

/** A worker that attaches and reports ready, as a healthy one does. */
const healthyWorker = (extra?: Answer) =>
  fakeWorker((message, reply) => {
    if (message.t === "connect") {
      reply({ t: "attached", idPrefix: "tab" });
      reply({ t: "connection", state: "ready" });
    }
    if (message.t === "ping") reply({ t: "pong" });
    extra?.(message, reply);
  });

test("a client whose worker stops answering reconnects through a new worker and delivers the queued message once", async () => {
  let saved: string | null = null;
  const f = world(undefined, {}, undefined, {
    load: async () => saved,
    save: async (value) => {
      saved = value;
    },
  });
  const scenario = new ScenarioPlayer(f.daemon, longHistory(1));
  scenario.runUntilBlocked();
  const clock = manualClock();
  const first = f.port();
  const losses: WorkerLoss[] = [];
  const reports: DiagnosticEvent[] = [];
  const remote = new RemoteClient(
    first.port,
    { daemon: "local" },
    {
      scheduler: clock.scheduler,
      now: clock.now,
      pingMs: 1_000,
      workerTimeoutMs: 3_000,
      report: (event) => reports.push(event),
      respawn({ cause }) {
        losses.push(cause);
        // The old worker is gone for good; a new one starts from the saved outbox.
        f.restartWorker();
        return { port: f.port().port };
      },
    },
  );
  cleanups.push(() => remote.close());
  await remote.start();
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  const lease = remote.thread(scenario.threadId);
  await vi.waitFor(() => expect(lease.store.thread).toBeDefined());

  // The worker keeps working but the tab never hears from it again: it saves and sends the
  // message, and the daemon accepts it, yet the tab's enqueue gets no reply.
  first.freeze();
  const payload = CommandPayload.parse({
    type: "thread.send",
    threadId: scenario.threadId,
    input: [{ type: "text", text: "Sent while the worker froze" }],
  });
  const sent = remote.enqueue(payload, "frozen-send");
  await f.faults.wait(
    (message) => message.type === "commandResult" && message.commandId === "frozen-send",
  );

  clock.advance(1_000 + 3_000);
  expect(losses).toEqual(["timeout"]);
  expect(remote.state).not.toBe("fatal");
  await expect(sent).resolves.toBe("frozen-send");
  await vi.waitFor(() => expect(remote.state).toBe("ready"));
  expect(remote.error).toBeUndefined();

  // The new worker serves the thread the tab held, and the daemon holds the message once.
  await vi.waitFor(() => expect(lease.store.item("input:frozen-send")).toBeDefined());
  expect(
    f.daemon
      .replay({ kind: "thread", threadId: ThreadId.parse(scenario.threadId) }, 0)
      .filter(
        (event) =>
          event.payload.type === "item.created" && event.payload.item.id === "input:frozen-send",
      ),
  ).toHaveLength(1);
  expect(remote.pendingSends().getSnapshot()).not.toContainEqual(
    expect.objectContaining({ commandId: "frozen-send", state: "failed" }),
  );
  expect(reports.map((report) => report.event)).toEqual(
    expect.arrayContaining([
      "client-worker.lost",
      "client-worker.respawned",
      "client-worker.recovered",
    ]),
  );
  expect(reports.find((report) => report.event === "client-worker.lost")?.data).toMatchObject({
    cause: "timeout",
  });
  lease.release();
});

test("a worker that keeps failing is retried with growing, capped waits and the client never parks in fatal", async () => {
  const clock = manualClock();
  const first = healthyWorker();
  const spawned: number[] = [];
  let healthyAfter = 8;
  const remote = new RemoteClient(
    first.port,
    {},
    {
      scheduler: clock.scheduler,
      id: () => "unused",
      pingMs: 1_000,
      workerTimeoutMs: 3_000,
      respawn() {
        spawned.push(clock.now());
        // Workers that never attach, until the ninth.
        return { port: (--healthyAfter > 0 ? fakeWorker() : healthyWorker()).port };
      },
    },
  );
  await remote.start();
  expect(remote.state).toBe("ready");
  const read = remote.request({ type: "diagnostics.health" });
  // The worker dies: every attach after this times out.
  first.port.postMessage = () => {};
  clock.advance(4_000);
  // A read in flight fails at once as offline, which a caller may retry; it never hangs.
  await expect(read).rejects.toMatchObject({ code: "offline" });
  for (let step = 0; step < 40 && remote.state !== "ready"; step++) {
    expect(remote.state).toBe("reconnecting");
    clock.advance(5_000);
    await Promise.resolve();
  }
  expect(remote.state).toBe("ready");
  expect(spawned).toHaveLength(8);
  const gaps = spawned.slice(1).map((at, index) => at - (spawned[index] ?? 0));
  for (let index = 1; index < gaps.length; index++)
    expect(gaps[index]).toBeGreaterThanOrEqual(gaps[index - 1] ?? 0);
  // Each wait is the attach deadline plus a backoff that never passes 30 s.
  expect(Math.max(...gaps)).toBeLessThanOrEqual(3_000 + 30_000);
  await remote.close();
});

test("a submitNew whose id the lost worker allocated goes to the next worker as a command under that id", async () => {
  const clock = manualClock();
  const payload = CommandPayload.parse({
    type: "thread.rename",
    threadId: ThreadId.parse("thread-1"),
    title: "Renamed across a worker loss",
  });
  let fail = noop;
  // The first worker allocates the id and then dies before answering.
  const first = healthyWorker((message, reply) => {
    if (message.t === "call" && message.method === "submitNew")
      reply({ t: "command.allocated", call: message.call, commandId: "allocated-1" });
  });
  const second = healthyWorker((message, reply) => {
    if (message.t !== "call" || message.method !== "command") return;
    const [, , id] = message.args;
    reply({
      t: "reply",
      call: message.call,
      value: { result: { commandId: id, ok: true }, intent: undefined },
    });
  });
  const recorded: string[] = [];
  const remote = new RemoteClient(
    first.port,
    {},
    {
      scheduler: clock.scheduler,
      id: () => "unused",
      workerFailure: {
        watch(lost) {
          fail = lost;
          return () => {};
        },
      },
      respawn: () => ({ port: second.port }),
    },
  );
  await remote.start();
  const result = remote.submitNew(payload, (id) => {
    recorded.push(id);
  });
  await vi.waitFor(() => expect(recorded).toEqual(["allocated-1"]));
  fail();
  expect(remote.state).toBe("reconnecting");
  clock.advance(0);
  await expect(result).resolves.toMatchObject({ commandId: "allocated-1", ok: true });
  expect(recorded).toEqual(["allocated-1"]);
  expect(
    second.received.filter((message) => message.t === "call" && message.method === "submitNew"),
  ).toEqual([]);
  expect(remote.state).toBe("ready");
  await remote.close();
});

test("the worker's connection drops reach the page's log once, however many tabs share it", async () => {
  const f = world();
  new ScenarioPlayer(f.daemon, longHistory(1)).runUntilBlocked();
  const reports: DiagnosticEvent[][] = [[], []];
  const tabs = reports.map((log) => f.tab("local", { report: (event) => log.push(event) }));
  await Promise.all(tabs.map((tab) => tab.start()));
  await vi.waitFor(() => expect(tabs.map((tab) => tab.state)).toEqual(["ready", "ready"]));
  f.daemon.disconnectAll(1006);
  await vi.waitFor(() =>
    expect(reports.flat()).toContainEqual({
      event: "connection.closed",
      data: expect.objectContaining({ code: 1006, next: "reconnecting" }),
    }),
  );
  await vi.waitFor(() => expect(tabs.map((tab) => tab.state)).toEqual(["ready", "ready"]));
  await vi.waitFor(() =>
    expect(reports.flat().map((report) => report.event)).toContain("connection.recovered"),
  );
  expect(reports.flat().filter((report) => report.event === "connection.closed")).toHaveLength(1);
});
