import { expect, it } from "vitest";
import { ThreadId, type MachineThreadView, type McpAttribution } from "@ace/protocol";
import { agentForest, type ThreadWork } from "@ace/ui-core";
import { setup } from "../agent-control/test-support.ts";
import { REMOTE_CHILD_LEASE_MS } from "../liveness/lease.ts";
import { REMOTE_STOP, stopBound } from "../liveness/stop.ts";
import { MachineChildren } from "./children.ts";
import { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

/*
 * Stop and proof of life for children on paired machines (ADR 0052), with a real parent engine
 * and store and the other machine played in memory. The live case of 2026-11-01: four Codex
 * children whose sessions never opened sat in `needs_you` there ("Not sent · Try again"), their
 * cancels went unanswered, and the parent waited on them for hours.
 */

const ids = [
  "machine-ac701089d8a17c6f75797c96fa508da3",
  "machine-5ddcfd640621a9aa2d24c3ac8b7e9786",
  "machine-a990182320557cc460f405839378e2bf",
  "machine-7ae8651c9d33b2d5e6c190fe76663513",
].map((id) => ThreadId.parse(id));

/** What the other machine answers: per child, its view; `silent` makes every read fail. */
interface Rijan {
  views: Map<string, MachineThreadView>;
  silent: boolean;
  cancels: string[];
  /** What a cancel does there; by default nothing changes (it never confirms). */
  onCancel: (id: string) => void;
}

function children(f: Awaited<ReturnType<typeof setup>>, rijan: Rijan) {
  return new MachineChildren({
    store: f.store,
    engine: () => f.engine,
    now: f.clock.now,
    schedule: (ms, run) => f.clock.setTimer(run, ms),
    pollMs: 1_000,
    status: async (_machine, _parent, wanted) => {
      if (rijan.silent) throw new MachineFailure("offline");
      return wanted.flatMap((id) => {
        const view = rijan.views.get(id);
        return view ? [view] : [];
      });
    },
    cancel: async (_machine, _parent, id) => {
      rijan.cancels.push(id);
      rijan.onCancel(id);
    },
    resend: async () => "taken" as const,
    mirror: new RequestMirror({
      store: f.store,
      engine: () => f.engine,
      respond: async () => {},
      log: () => {},
    }),
    label: () => "MacBook Pro Rijan",
    deliver: () => {},
    waiting: () => false,
    isDescendant: () => false,
    descendants: () => [],
    device: () => "device-rijan",
    log: () => {},
  });
}

const live = ["working", "waiting", "needs_you"];

const notSent = (id: ThreadId): MachineThreadView => ({
  threadId: id,
  state: "needs_you",
  title: `Rereview ${id.slice(-4)}`,
  elapsedSeconds: 24_646,
  status: { state: "waiting", on: "queue" },
  requests: [],
});

async function parentWithChildren(count = ids.length, path?: string) {
  const f = setup({}, path);
  const parent = await f.parent();
  const rijan: Rijan = { views: new Map(), silent: false, cancels: [], onCancel: () => {} };
  const ledger = children(f, rijan);
  for (const id of ids.slice(0, count)) {
    ledger.add({
      id,
      requestKey: `parent:${id}`,
      parentThreadId: parent.threadId,
      parentAgentId: parent.agentId,
      machine: "macbook-pro-rijan",
      role: `Rereview-${id.slice(-4)}`,
      provider: "codex",
      title: `Rereview ${id.slice(-4)}`,
      device: "device-rijan",
    });
    rijan.views.set(id, notSent(id));
  }
  await f.engine.flush();
  /** Moves the clock, runs what fell due, and polls the other machine once. */
  const at = async (time: number, on = ledger) => {
    f.clock.advance(time);
    await on.poll();
    await f.engine.flush();
  };
  return { f, parent, rijan, ledger, at };
}

/** The parent's tree as the Summary joins it, and its thread status. */
function parentView(f: Awaited<ReturnType<typeof setup>>, parent: McpAttribution) {
  const snapshot = f.store.snapshotThread(parent.threadId);
  const facts: ThreadWork = {
    agents: Object.values(snapshot.agents),
    tasks: Object.values(snapshot.backgroundTasks),
    interactions: Object.values(snapshot.interactions).filter(
      (interaction) => interaction.state === "pending",
    ),
    status: snapshot.thread.status,
  };
  const forest = agentForest(parent.threadId, new Map([[parent.threadId, facts]]));
  const flat = forest.roots.flatMap((root) => [root, ...root.children]);
  const rows = flat.filter((node) => node.kind === "agent" && node.agent.childThreadId);
  const holds = Object.values(snapshot.backgroundTasks).filter((task) => task.kind === "subagent");
  return { forest, rows, holds, status: snapshot.thread.status };
}

it("children whose sessions never opened, sitting in needs_you, end stopped after Stop even though their machine never confirms, and the parent stops waiting", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren();
  await at(f.clock.now() + 1_000);
  expect(parentView(f, parent).status.state).toBe("needs_you");

  // The person's Stop: each child's hold is stopped, which stops the child.
  for (const id of ids) expect(ledger.stop(id)).toBe(true);
  const start = f.clock.now();
  await at(start);
  expect(new Set(rijan.cancels)).toEqual(new Set(ids));

  // Rijan keeps reporting them as needing the person; each cancel is sent again with backoff.
  let time = start;
  for (const wait of REMOTE_STOP.map((step) => step.waitMs)) {
    time += wait;
    await at(time);
  }
  expect(rijan.cancels.length).toBe(ids.length * REMOTE_STOP.length);
  expect(time - start).toBe(stopBound(REMOTE_STOP));

  const caller = { sessionId: "s", threadId: parent.threadId, agentId: parent.agentId };
  for (const child of ledger.children(caller))
    expect(child).toMatchObject({ state: "cancelled", contact: "unconfirmed" });
  expect(ledger.watched(ids[0] ?? ThreadId.parse("x"))?.view.result).toContain(
    "never confirmed it stopped",
  );
  const view = parentView(f, parent);
  expect(view.holds.map((hold) => hold.status)).toEqual(ids.map(() => "stopped"));
  expect(view.rows.every((row) => row.kind === "agent" && !row.live)).toBe(true);
  expect(view.rows.map((row) => row.kind === "agent" && row.agent.machine?.contact)).toEqual(
    ids.map(() => "unconfirmed"),
  );
  expect(live).not.toContain(view.status.state);

  // No more cancels go out once it is stopped.
  const sent = rijan.cancels.length;
  await at(time + 60_000);
  expect(rijan.cancels.length).toBe(sent);
});

it("a child whose machine confirms the cancel ends with its real outcome and no warning", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.onCancel = (cancelled) =>
    rijan.views.set(cancelled, {
      ...notSent(id),
      state: "cancelled",
      status: { state: "done" },
      result: "Stopped.",
      truncated: false,
    });
  ledger.stop(id);
  await at(f.clock.now() + 1_000);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "cancelled", result: "Stopped." });
  expect(ledger.watched(id)?.view.contact).toBeUndefined();
  expect(rijan.cancels).toEqual([id]);
  expect(parentView(f, parent).holds.map((hold) => hold.status)).toEqual(["stopped"]);
});

it("a child whose machine goes silent becomes lost contact after the lease, releases the parent, and resumes when it reports", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await at(f.clock.now() + 1_000);
  expect(live).toContain(parentView(f, parent).status.state);

  rijan.silent = true;
  const quiet = f.clock.now();
  await at(quiet + REMOTE_CHILD_LEASE_MS - 1_000);
  // Inside the lease it still holds the parent.
  expect(live).toContain(parentView(f, parent).status.state);
  await at(quiet + REMOTE_CHILD_LEASE_MS + 1_000);

  const lost = parentView(f, parent);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "failed", contact: "lost" });
  expect(lost.holds.map((hold) => hold.status)).toEqual(["unknown"]);
  expect(lost.rows).toEqual([
    expect.objectContaining({
      live: false,
      agent: expect.objectContaining({ machine: expect.objectContaining({ contact: "lost" }) }),
    }),
  ]);
  expect(live).not.toContain(lost.status.state);

  // It reports again: it is in contact and holds its parent until it ends.
  rijan.silent = false;
  await at(f.clock.now() + 1_000);
  const back = parentView(f, parent);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "working" });
  expect(ledger.watched(id)?.view.contact).toBeUndefined();
  expect(back.holds.filter((hold) => hold.status === "running")).toHaveLength(1);
  expect(live).toContain(back.status.state);
});

it("a child stopped without confirmation is never revived by a late report, but takes its real end", async () => {
  const { f, rijan, ledger, at } = await parentWithChildren(1);
  const [id] = ids;
  if (!id) throw new Error("no child");
  ledger.stop(id);
  await at(f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await at(f.clock.now() + 1);
  expect(ledger.child(id)?.settled).toBe(true);

  // Still working there, read on a re-check: it stays stopped here.
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  for (let poll = 0; poll < 12; poll++) await at(f.clock.now() + 10_000);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "cancelled", contact: "unconfirmed" });

  // It ends there: its real end is recorded, still settled.
  rijan.views.set(id, {
    ...notSent(id),
    state: "done",
    status: { state: "done" },
    result: "Finished after all.",
    truncated: false,
  });
  for (let poll = 0; poll < 12; poll++) await at(f.clock.now() + 10_000);
  expect(ledger.child(id)?.settled).toBe(true);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "done", result: "Finished after all." });
});

it("a stop and a lease kept across a daemon restart are read again at startup", async () => {
  const first = await parentWithChildren(2);
  const [stopped, quiet] = ids;
  if (!stopped || !quiet) throw new Error("no children");
  first.rijan.views.set(quiet, {
    ...notSent(quiet),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await first.at(first.f.clock.now() + 1_000);
  first.ledger.stop(stopped);
  await first.at(first.f.clock.now() + 1);
  expect(first.rijan.cancels).toEqual([stopped]);
  first.ledger.close();

  // The daemon is down for an hour; its machine stopped answering meanwhile.
  first.rijan.silent = true;
  const boot = first.f.clock.now() + 60 * 60_000;
  first.f.clock.advance(boot);
  const restarted = children(first.f, first.rijan);
  await first.at(boot, restarted);
  // The stop is past its bound: stopped at once, without another round of cancels.
  expect(restarted.watched(stopped)?.view).toMatchObject({
    state: "cancelled",
    contact: "unconfirmed",
  });
  // Downtime here isn't silence there: the lease counts from startup.
  expect(restarted.watched(quiet)?.view.state).toBe("working");
  await first.at(boot + REMOTE_CHILD_LEASE_MS + 1_000, restarted);
  expect(restarted.watched(quiet)?.view).toMatchObject({ state: "failed", contact: "lost" });
  expect(live).not.toContain(parentView(first.f, first.parent).status.state);
  restarted.close();
});

it("the parent is never shown done while one of its children is still live", async () => {
  const { f, parent, rijan, ledger, at } = await parentWithChildren(2);
  const [stopped, running] = ids;
  if (!stopped || !running) throw new Error("no children");
  rijan.views.set(running, {
    ...notSent(running),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  ledger.stop(stopped);
  await at(f.clock.now() + stopBound(REMOTE_STOP) + 1);
  await at(f.clock.now() + 1);
  expect(ledger.watched(stopped)?.view.contact).toBe("unconfirmed");
  const view = parentView(f, parent);
  expect(live).toContain(view.status.state);
  expect(view.forest.roots.some((root) => root.live)).toBe(true);
  expect(view.rows.filter((row) => row.live)).toHaveLength(1);
});
