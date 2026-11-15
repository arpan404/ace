import { Command, ThreadId, type MachineThreadView, type McpAttribution } from "@ace/protocol";
import { agentForest, type ThreadWork } from "@ace/ui-core";
import { setup } from "../agent-control/test-support.ts";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { STOP_TRACKING } from "./child-lost.ts";
import { MachineChildren, UNREACHABLE_RETRY_CAP_MS } from "./children.ts";
import { REMOTE_CHILD_LEASE_MS } from "../liveness/lease.ts";
import { RequestMirror } from "./mirror.ts";
import { MachineFailure } from "./transport.ts";

/*
 * Children on a paired machine with a real parent engine and store, the other machine played in
 * memory (ADR 0052, ADR 0153). Shared by the stop and lost-contact tests.
 */

export const ids = [
  "machine-ac701089d8a17c6f75797c96fa508da3",
  "machine-5ddcfd640621a9aa2d24c3ac8b7e9786",
  "machine-a990182320557cc460f405839378e2bf",
  "machine-7ae8651c9d33b2d5e6c190fe76663513",
].map((id) => ThreadId.parse(id));

/** What the other machine answers: per child, its view; `silent` makes every read fail. */
export interface Rijan {
  views: Map<string, MachineThreadView>;
  silent: boolean;
  cancels: string[];
  /** What a cancel does there; by default nothing changes (it never confirms). */
  onCancel: (id: string) => void;
  /** False once the person unpairs Rijan from this machine. */
  paired: boolean;
}

export function children(
  f: Awaited<ReturnType<typeof setup>>,
  rijan: Rijan,
  leaseMs?: number,
  engine: () => Engine = () => f.engine,
  store: Store = f.store,
) {
  return new MachineChildren({
    ...(leaseMs ? { leaseMs } : {}),
    store,
    engine,
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
    device: () => (rijan.paired ? "device-rijan" : undefined),
    log: () => {},
  });
}

export const live = ["working", "waiting", "needs_you"];

export const notSent = (id: ThreadId): MachineThreadView => ({
  threadId: id,
  state: "needs_you",
  title: `Rereview ${id.slice(-4)}`,
  elapsedSeconds: 24_646,
  status: { state: "waiting", on: "queue" },
  requests: [],
});

export async function parentWithChildren(count = ids.length, leaseMs?: number) {
  const f = setup();
  const parent = await f.parent();
  const rijan: Rijan = {
    views: new Map(),
    silent: false,
    cancels: [],
    onCancel: () => {},
    paired: true,
  };
  const ledger = children(f, rijan, leaseMs);
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
export function parentView(f: Awaited<ReturnType<typeof setup>>, parent: McpAttribution) {
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

export type Fixture = Awaited<ReturnType<typeof setup>>;

/** The parent's open questions. */
export const asks = (f: Fixture, parent: McpAttribution) =>
  Object.values(f.store.snapshotThread(parent.threadId).interactions).filter(
    (interaction) => interaction.state === "pending",
  );

/** The person answers the question about the child: stop tracking it. */
export function stopTracking(ledger: MachineChildren, interactionId: string) {
  return ledger.resolve(
    Command.parse({
      id: `stop-tracking-${interactionId}`,
      deviceId: "person",
      payload: {
        type: "interaction.resolve",
        interactionId,
        resolution: { kind: "approval", optionId: STOP_TRACKING },
      },
    }),
  );
}

/**
 * Its machine answers again. It failed every read while silent, so the next read waits out that
 * machine's backoff, never longer than its cap; polls come once a second meanwhile.
 */
export async function answersAgain(
  fixture: Awaited<ReturnType<typeof parentWithChildren>>,
  id: ThreadId,
  on: MachineChildren = fixture.ledger,
) {
  const { f, rijan, at } = fixture;
  rijan.silent = false;
  const answered = f.clock.now();
  while (
    on.watched(id)?.view.contact === "lost" &&
    f.clock.now() < answered + UNREACHABLE_RETRY_CAP_MS
  )
    await at(f.clock.now() + 1_000, on);
}

/** A working child, its parent's own turn over, then its machine goes silent past the lease. */
export async function silentChild(leaseMs?: number) {
  const fixture = await parentWithChildren(1, leaseMs);
  const { f, parent, rijan, at } = fixture;
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await at(f.clock.now() + 1_000);
  // The parent's own turn ends: only its child keeps it open.
  await f.complete(parent.threadId, "Delegated the review.");
  if (!live.includes(parentView(f, parent).status.state)) throw new Error("parent not held");

  rijan.silent = true;
  const quiet = f.clock.now();
  // Asked and not answered: its lease runs from this read.
  await at(quiet);
  await at(quiet + (leaseMs ?? REMOTE_CHILD_LEASE_MS) + 1_000);
  return { ...fixture, id, quiet };
}
