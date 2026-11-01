import { expect, it } from "vitest";
import { ThreadId, type MachineThreadView, type McpAttribution } from "@ace/protocol";
import { agentForest, type ThreadWork } from "@ace/ui-core";
import { setup } from "../agent-control/test-support.ts";
import { MachineChildren } from "./children.ts";
import { RequestMirror } from "./mirror.ts";

/* A parent here with a child on a paired machine, read the way the Summary's agent tree reads it. */

const child = ThreadId.parse("machine-5ddcfd640621a9aa2d24c3ac8b7e9786");

/** The paired machine is played by `report`; the parent is a real engine and store. */
async function remoteChild() {
  const f = setup();
  const parent = await f.parent();
  let view: MachineThreadView | undefined;
  const children = new MachineChildren({
    store: f.store,
    engine: () => f.engine,
    now: f.clock.now,
    schedule: () => () => {},
    pollMs: 50,
    status: async () => (view ? [view] : []),
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
  children.add({
    id: child,
    requestKey: "parent:rereview",
    parentThreadId: parent.threadId,
    parentAgentId: parent.agentId,
    machine: "macbook-pro-rijan",
    role: "Rereview-1564-fixes",
    provider: "codex",
    title: "Rereview-1564-fixes",
    device: "device-rijan",
  });
  await f.engine.flush();
  const report = async (next: Partial<MachineThreadView>) => {
    view = {
      threadId: child,
      state: "working",
      title: "Rereview-1564-fixes",
      elapsedSeconds: 0,
      status: { state: "working", agents: 1 },
      requests: [],
      ...next,
    };
    await children.poll();
    await f.engine.flush();
  };
  return { f, parent, report, tree: () => readTree(f, parent) };
}

/** The parent's agent tree, as the Summary joins it, with the remote child's row. */
function readTree(f: Awaited<ReturnType<typeof setup>>, parent: McpAttribution) {
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
  const row = flat.find((node) => node.kind === "agent" && node.agent.childThreadId === child);
  const commands = flat.filter((node) => node.kind === "command");
  return { forest, row, commands, status: snapshot.thread.status };
}

it("a child on a paired machine that failed shows failed, not running", async () => {
  const { report, tree } = await remoteChild();
  expect(tree().row).toMatchObject({ kind: "agent", live: true });

  await report({
    state: "failed",
    status: { state: "failed" },
    result: "codex session opening failed: No matching provider instance",
  });
  const after = tree();
  expect(after.row).toMatchObject({
    kind: "agent",
    live: false,
    needsYou: false,
    agent: {
      native: { provider: "codex" },
      machine: { machine: "macbook-pro-rijan", name: "MacBook Pro Rijan" },
      status: { state: "failed" },
    },
  });
  expect(after.commands).toEqual([]);
  // Nothing else runs, so the parent's Summary leaves Working.
  expect(after.forest.roots.some((root) => root.live)).toBe(false);
  expect(after.status.state).not.toBe("working");
});

it("a child on a paired machine whose queue waits on the person reads as needing them", async () => {
  const { report, tree } = await remoteChild();
  // Its machine holds the message for the person after its session couldn't open.
  await report({ state: "needs_you", status: { state: "waiting", on: "queue" } });
  const after = tree();
  expect(after.row).toMatchObject({ kind: "agent", live: true, needsYou: true });
  expect(after.commands).toEqual([]);
  expect(after.status).toEqual({ state: "needs_you", interactions: 1 });
});
