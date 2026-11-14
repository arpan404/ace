import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  DeviceId,
  HostId,
  MachineCallRequest,
  ThreadId,
  type MachineThreadView,
} from "@ace/protocol";
import { setup } from "../agent-control/test-support.ts";
import { systemDeliveryRuntime } from "../delivery-runtime.ts";
import { tlsFixtureHome } from "../process-test-support.ts";
import { sniListener } from "../sni-listener.ts";
import { loadIdentity } from "../tls-identity.ts";
import { MachineChildren } from "./children.ts";
import { MachineConnections } from "./connections.ts";
import { RequestMirror } from "./mirror.ts";
import { machineStatusThreads } from "./status-result.ts";
import { machineRequest } from "./transport.ts";

/*
 * The three scheduling failures of review round 6, through real HTTPS: a status call to a real
 * listener for every read, a parent engine and store here, and the scheduler's clock moved by
 * the test. Each machine answers per call as the test says: answer, drop the connection, refuse
 * it as not_found, or never answer.
 */

const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

type Answer = "answer" | "drop" | "not_found" | "hang";
const token = "a".repeat(64);
const origin = {
  hostId: HostId.parse("host-here"),
  hostName: "MacBook",
  threadId: ThreadId.parse("parent"),
  threadTitle: "Parent",
  ceiling: "operate" as const,
};

const view = (id: string, state: "working" | "done"): MachineThreadView => ({
  threadId: ThreadId.parse(id),
  state,
  title: `Task ${id}`,
  elapsedSeconds: 5,
  status: state === "done" ? { state: "done" } : { state: "working", agents: 1 },
  requests: [],
  ...(state === "done" ? { result: `Done ${id}.`, truncated: false } : {}),
});

/** A machine on a real listener: its children's views, and how it answers each call. */
async function remote(name: string, decide: (ids: readonly string[]) => Answer) {
  const views = new Map<string, MachineThreadView>();
  const calls: { ids: string[]; at: number }[] = [];
  const listener = sniListener({
    tls: identity,
    requests: (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { call } = MachineCallRequest.parse(JSON.parse(Buffer.concat(chunks).toString()));
        if (call.op !== "status") return response.writeHead(200).end("{}");
        const ids = call.threadIds.map(String);
        calls.push({ ids, at: Date.now() });
        const answer = decide(ids);
        if (answer === "hang") return;
        if (answer === "drop") return request.socket.destroy();
        response.setHeader("content-type", "application/json");
        if (answer === "not_found")
          return response
            .writeHead(404)
            .end(JSON.stringify({ error: "not_found", message: "No such thread from that machine." }));
        response.writeHead(200).end(
          JSON.stringify({ threads: ids.flatMap((id) => (views.get(id) ? [views.get(id)] : [])) }),
        );
      });
    },
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
  const port = await listener.listen("127.0.0.1", 0);
  cleanups.push(() => listener.close());
  const profile = {
    id: "5b0f3f4e-8f3a-4b8e-9d3c-2f6a1c7e9b10",
    name,
    origin: `https://127.0.0.1:${port}/`,
    fingerprint: identity.fingerprint,
    deviceId: DeviceId.parse(`device-${name}`),
    token,
  };
  return { name, views, calls, profile };
}

/** Children on the given machines, read through real HTTPS, with a parent here. */
async function parentWatching(machines: Awaited<ReturnType<typeof remote>>[], timeoutMs = 10_000) {
  const f = setup();
  const parent = await f.parent();
  const connections = new MachineConnections({
    schedule: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  cleanups.push(() => connections.close());
  const byName = new Map(machines.map((entry) => [entry.name, entry]));
  const ledger = new MachineChildren({
    store: f.store,
    engine: () => f.engine,
    now: f.clock.now,
    schedule: (ms, run) => f.clock.setTimer(run, ms),
    pollMs: 1_000,
    status: async (machine, _parent, ids) => {
      const target = byName.get(machine);
      if (!target) throw new Error(`No machine ${machine}`);
      return machineStatusThreads(
        await machineRequest(
          target.profile,
          { origin, call: { op: "status", threadIds: [...ids] } },
          { timeoutMs, connections },
        ),
      );
    },
    cancel: async () => {},
    resend: async () => "taken" as const,
    mirror: new RequestMirror({
      store: f.store,
      engine: () => f.engine,
      respond: async () => {},
      log: () => {},
    }),
    label: (machine) => machine,
    deliver: () => {},
    waiting: () => false,
    isDescendant: () => false,
    descendants: () => [],
    device: (machine) => `device-${machine}`,
    log: () => {},
  });
  cleanups.push(() => ledger.close());
  const add = (machine: Awaited<ReturnType<typeof remote>>, id: string, state: "working" | "done" = "working") => {
    ledger.add({
      id: ThreadId.parse(id),
      requestKey: `parent:${id}`,
      parentThreadId: parent.threadId,
      parentAgentId: parent.agentId,
      machine: machine.name,
      role: `Task-${id}`,
      provider: "codex",
      title: `Task ${id}`,
      device: `device-${machine.name}`,
    });
    machine.views.set(id, view(id, state));
  };
  /** Moves the scheduler's clock in steps, a poll at each, waiting for that poll's calls. */
  const pass = async (ms: number, step = 1_000) => {
    const until = f.clock.now() + ms;
    while (f.clock.now() < until) {
      f.clock.advance(Math.min(f.clock.now() + step, until));
      await ledger.poll();
      // Real calls take real time: each step waits for the calls it started to come back.
      await ledger.flush();
    }
    await f.engine.flush();
  };
  const state = (id: string) => ledger.watched(ThreadId.parse(id))?.view.state;
  const parentState = () => f.store.getThread(parent.threadId)?.status.state;
  return { f, ledger, add, pass, state, parentState };
}

it("a child that takes calls down with it is never batched with one that answers, round after round", async () => {
  // Any call asking about child-a with another loses its connection; each answers alone.
  const studio = await remote("studio", (ids) => (ids.length > 1 && ids.includes("child-a") ? "drop" : "answer"));
  const h = await parentWatching([studio]);
  h.add(studio, "child-a", "done");
  h.add(studio, "child-b", "done");
  await h.pass(5_000);
  expect(h.state("child-a")).toBe("done");
  expect(h.state("child-b")).toBe("done");
  // Hours of re-checks later, child-b starts again there.
  await h.pass(3 * 60 * 60 * 1000, 60_000);
  studio.views.set("child-b", view("child-b", "working"));
  await h.pass(6 * 60 * 1000, 10_000);
  expect(h.state("child-b")).toBe("working");
  expect(["working", "waiting", "needs_you"]).toContain(h.parentState());
  // Each time child-a took a shared call down it stayed alone twice as long, up to an hour: over
  // three hours it rejoined a handful of times, never every round.
  const shared = studio.calls.filter((call) => call.ids.length > 1 && call.ids.includes("child-a"));
  expect(shared.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2((3 * 60 * 60) / 10)) + 2);
});

it("a healthy child's view arrives while fifteen reads beside it hang, and another machine's turn goes on", async () => {
  const unknown = Array.from({ length: 15 }, (_, index) => `stuck-${String(index).padStart(2, "0")}`);
  // Any call naming one of them is refused as not_found; each of them alone never answers.
  const studio = await remote("studio", (ids) => {
    if (ids.length > 1 && ids.some((id) => unknown.includes(id))) return "not_found";
    return unknown.includes(ids[0] ?? "") ? "hang" : "answer";
  });
  const laptop = await remote("laptop", () => "answer");
  const h = await parentWatching([studio, laptop], 50_000);
  h.add(studio, "healthy");
  for (const id of unknown) h.add(studio, id);
  h.add(laptop, "elsewhere");
  // The first turn's call is refused for the unknown ones' sake: each is asked alone next.
  await h.pass(1_000);
  studio.views.set("healthy", view("healthy", "done"));
  h.f.clock.advance(h.f.clock.now() + 1_000);
  const slow = h.ledger.poll();
  // Its view is applied as soon as it arrives, not when the hanging reads give up.
  await expect.poll(() => h.state("healthy"), { timeout: 2_000 }).toBe("done");
  // Another poll, while those reads still hang, reads the other machine at once.
  laptop.views.set("elsewhere", view("elsewhere", "done"));
  h.f.clock.advance(h.f.clock.now() + 1_000);
  const next = h.ledger.poll();
  await expect.poll(() => h.state("elsewhere"), { timeout: 2_000 }).toBe("done");
  await next;
  h.ledger.close();
  void slow;
});

it("a child whose reads keep failing backs off to the cap even while its neighbour answers every time", async () => {
  // child-a's read alone always loses its connection; child-b always answers.
  const studio = await remote("studio", (ids) => (ids.includes("child-a") ? "drop" : "answer"));
  const h = await parentWatching([studio]);
  h.add(studio, "child-a");
  h.add(studio, "child-b");
  await h.pass(3 * 60_000);
  const before = studio.calls.filter((call) => call.ids.includes("child-a")).length;
  await h.pass(60_000);
  const after = studio.calls.filter((call) => call.ids.includes("child-a")).length;
  // At the 30 s cap it is asked about twice a minute; every poll would be sixty.
  expect(after - before).toBeLessThanOrEqual(3);
  expect(h.state("child-b")).toBe("working");
});
