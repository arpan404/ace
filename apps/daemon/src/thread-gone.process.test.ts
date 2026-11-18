import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentId, Command, ThreadId, type McpAttribution, type WorkspaceId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { end } from "./engine/test-support.ts";
import { ChildLedger } from "./machines/child-ledger.ts";
import { ThreadLifecycle } from "./thread-lifecycle.ts";
import { purgeThread, retireThread } from "./thread-gone.ts";
import type { Store } from "./store.ts";

/*
 * The invariant of ADR 0183: however a thread goes (the person deletes it, its project is
 * removed, storage cleanup retires it) and once its data is purged, a restart brings every
 * service up and nothing open still refers to it.
 */

type Fixture = Awaited<ReturnType<typeof daemonFixture>>;
type Daemon = Fixture["daemon"];
type Tree = {
  workspace: WorkspaceId;
  caller: McpAttribution;
  limited: ThreadId;
  running: ThreadId;
};

const paths: { name: string; retire(f: Fixture, tree: Tree): Promise<void> }[] = [
  {
    name: "the person deletes it",
    async retire(f, { caller }) {
      const { engine } = controlsOf(f.daemon);
      const lifecycle = new ThreadLifecycle({
        store: f.daemon.store,
        engine,
        handler: engine.handler,
        port: 0,
        hostId: "test",
        token: "unused",
        now: f.h.clock.now,
      });
      const deleted = await lifecycle.delete(
        Command.parse({
          id: "delete-parent",
          deviceId: "desktop",
          payload: { type: "thread.delete", threadId: caller.threadId, force: true },
        }),
      );
      expect(deleted).toMatchObject({ ok: true });
    },
  },
  {
    name: "its project is removed",
    async retire(f, { workspace }) {
      const removed = await f.daemon.projects.execute(
        Command.parse({
          id: "remove-project",
          deviceId: "desktop",
          payload: { type: "workspace.remove", workspaceId: workspace, stopRunning: true },
        }),
      );
      expect(removed).toMatchObject({ ok: true });
    },
  },
  {
    name: "storage cleanup retires it",
    async retire(f, { caller }) {
      await f.daemon.engine?.stopForDeletion(caller.threadId);
      retireThread(
        f.daemon.store,
        caller.threadId,
        f.h.clock.now(),
        (id, command) => f.daemon.engine?.prepareDeletion(id, command),
        `storage:${caller.threadId}`,
      );
    },
  },
];

function controlsOf(daemon: Daemon) {
  const controls = daemon.agentControl;
  if (!controls || !daemon.engine) throw new Error("Agent control is down");
  return { controls, engine: daemon.engine };
}

/** A new parent thread in a project of its own. */
async function parentIn(f: Fixture, daemon: Daemon, name: string) {
  const { controls, engine } = controlsOf(daemon);
  const folder = join(f.h.home, name);
  mkdirSync(folder);
  const workspace = daemon.store.createWorkspace(folder, name);
  const created = controls.delegations.command(`create-${name}`, {
    type: "thread.create",
    workspaceId: workspace,
    provider: "codex",
    access: "full-access",
    input: [{ type: "text", text: "plan" }],
  });
  await engine.flush();
  const thread = created.threadId ? daemon.store.getThread(created.threadId) : undefined;
  if (!thread?.rootAgentId) throw new Error("Parent unavailable");
  const caller: McpAttribution = {
    sessionId: "test",
    threadId: thread.id,
    agentId: thread.rootAgentId,
  };
  return { workspace, caller };
}

async function delegate(daemon: Daemon, caller: McpAttribution, name: string) {
  const { controls, engine } = controlsOf(daemon);
  const result = await controls.port.execute(
    caller,
    { op: "delegate_task", requestId: name, provider: "claude", task: `Do ${name}`, role: name },
    new AbortController().signal,
  );
  await engine.flush();
  return z.object({ threadId: ThreadId }).parse(result.data).threadId;
}

/**
 * A parent with a child stopped on its usage limit (its edge settled, the child still limited),
 * a child still running, and a settled child on another machine that is still re-checked.
 */
async function tree(f: Fixture, daemon: Daemon, name: string): Promise<Tree> {
  const { workspace, caller } = await parentIn(f, daemon, name);
  const limited = await delegate(daemon, caller, `${name}-limited`);
  f.h.contexts
    .get(limited)
    ?.onFrame(
      f.h.frames.frame(
        { type: "retry", agent: "root", on: "rate_limit", until: 5000, message: "Quota" },
        { ...end, outcome: "failed", error: { kind: "quota", message: "Quota" } },
      ),
    );
  await daemon.engine?.flush();
  await vi.waitFor(() => expect(daemon.store.getThread(limited)?.status.state).toBe("limited"));
  const running = await delegate(daemon, caller, `${name}-running`);
  const ledger = new ChildLedger(daemon.store);
  const remote = ThreadId.parse(`${name}-remote`);
  ledger.insert({
    id: remote,
    requestKey: `${caller.threadId}:remote`,
    parentThreadId: caller.threadId,
    parentAgentId: AgentId.parse(caller.agentId),
    machine: "studio",
    role: "remote",
    provider: "claude",
    createdAt: f.h.clock.now(),
    view: undefined,
    device: "device-studio",
  });
  ledger.writeView(remote, JSON.stringify({ state: "done" }), true, f.h.clock.now());
  return { workspace, caller, limited, running };
}

/** A thread gone by `column`: deleted, or holding no engine state. */
const gone = (column: string) =>
  `(SELECT 1 FROM threads t WHERE t.id=${column} AND (json_extract(t.client,'$.deletedAt') IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM thread_state s WHERE s.thread_id=t.id)))`;

/** Threads deleted, or holding no engine state, that something open still names. */
function dangling(store: Store) {
  const ids = (sql: string) =>
    store
      .statement(sql)
      .all()
      .map((row) => String(row.id));
  return {
    edges: ids(
      `SELECT child_id AS id FROM delegated_threads WHERE phase<>'settled' AND EXISTS ${gone("parent_id")}`,
    ),
    wakes: ids(`SELECT parent_id AS id FROM delegation_wakes WHERE EXISTS ${gone("parent_id")}`),
    launches: ids(
      `SELECT child_id AS id FROM delegation_launch_queue WHERE EXISTS ${gone("parent_id")}`,
    ),
    // A purged thread keeps no engine rows that would lead a reader to its missing state.
    engineRows: ["engine_sessions", "engine_transitions", "engine_queue"].flatMap((table) =>
      ids(
        `SELECT thread_id AS id FROM ${table} WHERE thread_id IN (SELECT thread_id FROM storage_purged)`,
      ),
    ),
    machineChildren: ids(
      `SELECT id FROM machine_children WHERE (settled=0 OR settled_at IS NOT NULL)
        AND EXISTS ${gone("parent_thread")}`,
    ),
  };
}

it("a parent retired through every deletion path and purged leaves every service up, with nothing open naming it, after a restart", async () => {
  const f = await daemonFixture();
  let daemon = f.daemon;
  try {
    const trees: Tree[] = [];
    for (const [index, path] of paths.entries()) {
      const built = await tree(f, daemon, `tree-${index}`);
      await path.retire(f, built);
      await daemon.engine?.stopForDeletion(built.caller.threadId);
      await purgeThread(daemon.store, built.caller.threadId, f.h.clock.now());
      daemon.engine?.forgetPurged(built.caller.threadId);
      trees.push(built);
    }

    daemon = await f.restart();
    await vi.waitFor(
      () => {
        const states = new Map(daemon.serviceStatus().map((s) => [s.name, s.state]));
        for (const name of [
          "agentControl",
          "machines",
          "transfers",
          "externalMcp",
          "notifications",
        ])
          expect(states.get(name), name).toBe("ready");
      },
      { timeout: 10_000 },
    );
    // The notification log replays past the purged threads.
    expect(await daemon.notifications.cursor()).toBeGreaterThan(0);
    await vi.waitFor(() =>
      expect(dangling(daemon.store)).toEqual({
        edges: [],
        wakes: [],
        launches: [],
        engineRows: [],
        machineChildren: [],
      }),
    );
    const { controls } = controlsOf(daemon);
    for (const [index, built] of trees.entries()) {
      // The limited child is left as it was; the running one was cancelled by the deletion
      // policy, and its edge says so.
      expect(daemon.store.getThread(built.limited)?.status.state, paths[index]?.name).toBe(
        "limited",
      );
      expect(controls.delegations.journal.get(built.running), paths[index]?.name).toMatchObject({
        phase: "settled",
        outcome: { outcome: "cancelled" },
      });
    }

    // Agent control's tools still work for a live thread.
    const next = await parentIn(f, daemon, "next");
    const child = await delegate(daemon, next.caller, "after-restart");
    expect(controls.delegations.journal.get(child)?.phase).toBe("running");
  } finally {
    await daemon.close();
  }
});
