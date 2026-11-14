import { expect, it } from "vitest";
import { Command, ThreadId, type MachineThreadView } from "@ace/protocol";
import { setup } from "../agent-control/test-support.ts";
import { RECHECK_WINDOW_MS } from "./child-recheck.ts";
import { STOP_TRACKING } from "./child-lost.ts";
import { MachineChildren } from "./children.ts";
import { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

/*
 * Settled children on a machine whose pairing is removed, and children the other machine says it
 * doesn't hold, with a real parent engine and store and the other machine played in memory. An
 * unpaired machine is never an answer: such a child is never counted as checked, costs no calls,
 * is read again once its machine is paired back, and asks the person, as a working child's does,
 * once it can no longer be watched through its window.
 */

const HOUR = 60 * 60 * 1000;

interface Studio {
  views: Map<string, MachineThreadView>;
  paired: boolean;
  /** Ids it holds no record of from this machine: a status call naming one is refused. */
  unknown: Set<string>;
  calls: string[][];
}

const view = (id: string, state: "working" | "done", result?: string): MachineThreadView => ({
  threadId: ThreadId.parse(id),
  state,
  title: `Task ${id}`,
  elapsedSeconds: 5,
  status: state === "done" ? { state: "done" } : { state: "working", agents: 1 },
  requests: [],
  ...(result ? { result, truncated: false } : {}),
});

async function parentWith(idList: readonly string[]) {
  const f = setup();
  const parent = await f.parent();
  const studio: Studio = { views: new Map(), paired: true, unknown: new Set(), calls: [] };
  const ledger = new MachineChildren({
    store: f.store,
    engine: () => f.engine,
    now: f.clock.now,
    schedule: (ms, run) => f.clock.setTimer(run, ms),
    pollMs: 1_000,
    status: async (_machine, _parent, wanted) => {
      studio.calls.push([...wanted]);
      if (wanted.some((id) => studio.unknown.has(id)))
        throw new MachineFailure("refused", "not_found", "No such thread from that machine.");
      return wanted.flatMap((id) => {
        const found = studio.views.get(id);
        return found ? [found] : [];
      });
    },
    cancel: async () => {},
    resend: async () => "taken" as const,
    mirror: new RequestMirror({
      store: f.store,
      engine: () => f.engine,
      respond: async () => {},
      log: () => {},
    }),
    label: () => "Studio",
    deliver: () => {},
    waiting: () => false,
    isDescendant: () => false,
    descendants: () => [],
    device: () => (studio.paired ? "device-studio" : undefined),
    log: () => {},
  });
  for (const id of idList) {
    ledger.add({
      id: ThreadId.parse(id),
      requestKey: `parent:${id}`,
      parentThreadId: parent.threadId,
      parentAgentId: parent.agentId,
      machine: "studio",
      role: `Task-${id}`,
      provider: "codex",
      title: `Task ${id}`,
      device: "device-studio",
    });
    studio.views.set(id, view(id, "working"));
  }
  await f.engine.flush();
  /** Lets `ms` pass in steps of `step`, the children's own timers and a poll at each. */
  const pass = async (ms: number, step = 10_000) => {
    const until = f.clock.now() + ms;
    while (f.clock.now() < until) {
      f.clock.advance(Math.min(f.clock.now() + step, until));
      await ledger.poll();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await f.engine.flush();
  };
  const state = (id: string) => ledger.watched(ThreadId.parse(id))?.view.state;
  const asks = () =>
    Object.values(f.store.snapshotThread(parent.threadId).interactions).filter(
      (interaction) => interaction.state === "pending",
    );
  return { f, parent, studio, ledger, pass, state, asks };
}

it("a settled child on a machine unpaired across its 24 h mark is read again once paired back", async () => {
  const h = await parentWith(["child-a"]);
  h.studio.views.set("child-a", view("child-a", "done", "Done."));
  await h.pass(2_000);
  expect(h.state("child-a")).toBe("done");

  // Unpaired an hour before its 24 h mark; it starts again there meanwhile.
  await h.pass(RECHECK_WINDOW_MS - HOUR, 60_000);
  h.studio.paired = false;
  h.studio.views.set("child-a", view("child-a", "working"));
  const before = h.studio.calls.length;
  await h.pass(2 * HOUR, 60_000);
  // Nothing was asked while it couldn't be.
  expect(h.studio.calls.length).toBe(before);

  h.studio.paired = true;
  await h.pass(60_000);
  expect(h.state("child-a")).toBe("working");
});

it("a settled child whose machine stays unpaired past its 24 h mark asks the person", async () => {
  const h = await parentWith(["child-a"]);
  h.studio.views.set("child-a", view("child-a", "done", "Done."));
  await h.pass(2_000);
  h.studio.paired = false;
  await h.pass(RECHECK_WINDOW_MS + 10 * 60 * 1000, 60_000);
  // It can't be watched any more: the parent asks the person, as for a working child.
  const [ask] = h.asks();
  expect(ask?.request).toMatchObject({ kind: "approval" });
  expect(JSON.stringify(ask?.request)).toContain("Studio");

  // The person stops watching it: it stays done with its result, and is never asked about again.
  if (!ask) throw new Error("No question for the person");
  const command = Command.parse({
    id: "stop-watching",
    deviceId: "person",
    payload: {
      type: "interaction.resolve",
      interactionId: ask.id,
      resolution: { kind: "approval", optionId: STOP_TRACKING },
    },
  });
  expect(h.ledger.resolve(command)).toMatchObject({ ok: true });
  await h.f.engine.flush();
  expect(h.asks()).toEqual([]);
  expect(h.state("child-a")).toBe("done");
  h.studio.paired = true;
  const before = h.studio.calls.length;
  await h.pass(HOUR, 60_000);
  expect(h.studio.calls.length).toBe(before);
});

it("a settled child asking the person is watched again when its machine is paired back", async () => {
  const h = await parentWith(["child-a"]);
  h.studio.views.set("child-a", view("child-a", "done", "Done."));
  await h.pass(2_000);
  h.studio.paired = false;
  await h.pass(RECHECK_WINDOW_MS + 10 * 60 * 1000, 60_000);
  expect(h.asks()).toHaveLength(1);
  h.studio.views.set("child-a", view("child-a", "working"));
  h.studio.paired = true;
  await h.pass(60_000);
  expect(h.asks()).toEqual([]);
  expect(h.state("child-a")).toBe("working");
});

it("a child its machine holds no record of never stops the others in its call being read", async () => {
  const h = await parentWith(["child-a", "child-b"]);
  h.studio.unknown.add("child-b");
  h.studio.views.set("child-a", view("child-a", "done", "Done."));
  await h.pass(5_000);
  expect(h.state("child-a")).toBe("done");
  // The unknown one stays as it was last seen, never settled for want of an answer.
  expect(h.state("child-b")).toBe("working");
});

it("a settled child its machine no longer holds is read and let go, never asked about forever", async () => {
  const h = await parentWith(["child-a", "child-b"]);
  h.studio.views.set("child-a", view("child-a", "done", "Done."));
  h.studio.views.set("child-b", view("child-b", "done", "Done too."));
  await h.pass(2_000);
  h.studio.unknown.add("child-b");
  h.studio.views.set("child-a", view("child-a", "working"));
  await h.pass(60_000);
  expect(h.state("child-a")).toBe("working");
  await h.pass(RECHECK_WINDOW_MS + HOUR, 60_000);
  const before = h.studio.calls.filter((call) => call.includes("child-b")).length;
  await h.pass(HOUR, 60_000);
  expect(h.studio.calls.filter((call) => call.includes("child-b")).length).toBe(before);
});
