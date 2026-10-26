import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MonitorSnapshot, ThreadId, WaitResult, type AgentControlOperation } from "@ace/protocol";
import { SettingsService } from "@ace/settings";
import { pairedMachines } from "./machine-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const Delegated = z.object({ threadId: ThreadId });
const task = (name: string) =>
  ({
    op: "delegate_task",
    requestId: `${name}-on-studio`,
    task: `Do the ${name} part`,
    role: `Do-${name}-part`,
    provider: "claude",
    machine: "studio",
    project: "project",
  }) satisfies AgentControlOperation;
const delegate = async (pair: Pair, name: string) =>
  Delegated.parse((await pair.source.call(task(name))).data).threadId;
const stateHere = async (pair: Pair, id: ThreadId) =>
  MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
    (child) => child.id === id,
  )?.state;
const waitFor = async (pair: Pair, id: ThreadId) =>
  WaitResult.parse(
    (await pair.source.call({ op: "wait", threadIds: [id], mode: "all", timeoutSeconds: 60 })).data,
  ).threads[0];
/** The source parent's own agent ends its turn, as a provider reports it. */
async function endParentTurn(pair: Pair, text: string) {
  const { source } = pair;
  const context = source.h.contexts.get(source.caller.threadId);
  if (!context) throw new Error("Parent session not open");
  context.onFrame(
    source.h.frames.frame(
      {
        type: "item.upsert",
        agent: "root",
        item: randomUUID(),
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    ),
  );
  await source.daemon.engine?.flush();
}

it("a parent whose own turn ends while its only child waits on a full machine stays waiting, and hears the result", async () => {
  // The target's one engine slot is held by its own working thread.
  const pair = await pairedMachines({
    access: "operate",
    targetEngineLimits: { maxActiveThreads: 1 },
  });
  await pair.source.call({ op: "machines" });
  // Someone on that machine is running a Claude thread, which takes its one engine slot.
  const busy = pair.target.controls.delegations.command("busy-there", {
    type: "thread.create",
    workspaceId: pair.target.workspace,
    provider: "claude",
    input: [{ type: "text", text: "Long local work" }],
  });
  if (!busy.ok || !busy.threadId) throw new Error("Busy thread not started");
  const busyThread = busy.threadId;
  // Mid-turn, so its slot can't be reclaimed for the child.
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(busyThread) ?? []).join("\n")).toContain("Long local work"),
    { timeout: 15_000 },
  );
  const child = await delegate(pair, "on-full-machine");
  expect(pair.target.daemon.store.getThread(child)?.queuedLaunch).toBeDefined();
  expect(pair.target.h.contexts.get(child)).toBeUndefined();

  // Nothing else of the parent's runs: its only child is queued, and its own turn ends.
  await endParentTurn(pair, "Waiting on the other machine.");
  expect(await stateHere(pair, child)).toBe("queued");
  // Its own agent is idle, yet it waits on the queued child instead of reading done.
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status).toMatchObject({
    state: "waiting",
  });

  // The machine's own work finishes, its engine slot frees, and the child starts there.
  await pair.finishTask(busyThread, "Long local work", "Done with my own work.");
  await vi.waitFor(() => expect(pair.target.h.contexts.get(child)).toBeDefined(), {
    timeout: 15_000,
  });
  await pair.finishTask(child, "Do the on-full-machine part", "Finished on the full machine.");
  expect(await waitFor(pair, child)).toMatchObject({
    state: "done",
    result: "Finished on the full machine.",
  });
}, 60_000);

it("waiting tasks survive a restart of the other machine: they start when a slot frees, a retried request is the same child, and cancelling still works", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const running = await delegate(pair, "running");
  const waiting = await delegate(pair, "waiting");
  const cancelled = await delegate(pair, "cancelled-later");
  expect(await stateHere(pair, waiting)).toBe("queued");

  // The running child is mid-turn, so the restart resumes it and it keeps its slot; restarted
  // before its task reached the provider, it would end with the restart and free the slot.
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(running) ?? []).join("\n")).toContain("Do the running part"),
    { timeout: 15_000 },
  );
  await pair.restartTarget();
  expect(pair.target.daemon.store.getThread(waiting)?.queuedLaunch?.text).toBe(
    "Do the waiting part",
  );
  await vi.waitFor(async () => expect(await stateHere(pair, waiting)).toBe("queued"), {
    timeout: 15_000,
  });

  // A retry whose first reply was lost reaches the target again: the source forgets it sent
  // the request, and the target answers with the same queued child instead of a second one.
  pair.source.daemon.store.statement("DELETE FROM machine_children WHERE id=?").run(waiting);
  expect(await delegate(pair, "waiting")).toBe(waiting);
  expect(
    pair.target.daemon.store.listThreads().filter((thread) => thread.title === "Do-waiting-part"),
  ).toHaveLength(1);
  expect(await stateHere(pair, waiting)).toBe("queued");

  // Cancelling a waiting child after the restart settles it without running.
  const stop = await pair.source.call({
    op: "agent.cancel",
    threadId: cancelled,
    requestId: "stop-after-restart",
  });
  expect(stop.ok).toBe(true);
  expect(await waitFor(pair, cancelled)).toMatchObject({
    state: "cancelled",
    result: "Stopped before it started.",
  });

  // The running child stops, its slot frees, and the waiting one starts; the cancelled never does.
  const freed = await pair.source.call({
    op: "agent.cancel",
    threadId: running,
    requestId: "stop-running",
  });
  expect(freed.ok).toBe(true);
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(waiting) ?? []).join("\n")).toContain("Do the waiting part"),
    { timeout: 15_000 },
  );
  await pair.finishTask(waiting, "Do the waiting part", "Waited through a restart.");
  expect(await waitFor(pair, waiting)).toMatchObject({
    state: "done",
    result: "Waited through a restart.",
  });
  expect(pair.target.h.inputs.get(cancelled) ?? []).toEqual([]);
}, 90_000);

it("a delegation made before the slot table existed counts against the limit once the daemon upgrades", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const existing = await delegate(pair, "made-before-upgrade");
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(existing) ?? []).join("\n")).toContain(
        "Do the made-before-upgrade part",
      ),
    { timeout: 15_000 },
  );
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });

  // The database goes back to the layout before run slots were tracked: the delegation is in
  // machine_threads only, before the two latest schema steps. Starting the daemon upgrades it.
  await pair.restartTarget((dataDir) => {
    const db = new DatabaseSync(join(dataDir, "events.sqlite"));
    try {
      db.exec(
        "DROP TABLE machine_child_launches; DROP TRIGGER machine_message_rejections_revoked; DROP TABLE machine_message_rejections; DROP TABLE machine_child_cursors; DROP INDEX machine_children_unsettled; DROP INDEX machine_children_parent; DROP INDEX machine_children_undelivered; ALTER TABLE machine_children DROP COLUMN device_id",
      );
      const version = Number(db.prepare("SELECT version FROM schema_version").get()?.version);
      db.prepare("UPDATE schema_version SET version=?").run(version - 2);
    } finally {
      db.close();
    }
  });
  // The earlier child was mid-turn, so the upgraded daemon resumes it and it runs again.
  await vi.waitFor(
    () => expect(pair.target.daemon.store.getThread(existing)?.status.state).toBe("working"),
    { timeout: 15_000 },
  );

  // The earlier child holds the calling thread's one slot, so the next one waits.
  const next = await delegate(pair, "after-upgrade");
  expect(pair.target.daemon.store.getThread(next)?.queuedLaunch).toBeDefined();
  expect(await stateHere(pair, next)).toBe("queued");
}, 60_000);

it("a slot freed while the other machine was down goes to the waiting task as soon as it starts again", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.target.daemon.settings.set("agents.maxRunningChildren", 1, { kind: "global" });
  await pair.source.call({ op: "machines" });
  const running = await delegate(pair, "keeps-running");
  const waiting = await delegate(pair, "waits-for-room");
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(running) ?? []).join("\n")).toContain(
        "Do the keeps-running part",
      ),
    { timeout: 15_000 },
  );
  expect(await stateHere(pair, waiting)).toBe("queued");

  // While it is down its settings file gains room for a second child: no change event fires,
  // so only the drain when it starts again can start the waiting task.
  await pair.restartTarget(async (dataDir) => {
    const settings = new SettingsService({ dataDir });
    try {
      await settings.set("agents.maxRunningChildren", 2, { kind: "global" });
    } finally {
      await settings.close();
    }
  });
  await vi.waitFor(
    () =>
      expect((pair.target.h.inputs.get(waiting) ?? []).join("\n")).toContain(
        "Do the waits-for-room part",
      ),
    { timeout: 15_000 },
  );
  expect(pair.target.daemon.store.getThread(waiting)?.queuedLaunch).toBeUndefined();
}, 60_000);
