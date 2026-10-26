import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Command,
  MonitorSnapshot,
  ThreadId,
  WaitResult,
  type AgentControlOperation,
} from "@ace/protocol";
import { Profiles } from "../cli/profiles.ts";
import { ThreadLifecycle } from "../thread-lifecycle.ts";
import { gatedTransport, pairedMachines } from "./machine-test-support.ts";

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
const eventually = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 15_000 });
const shownHere = async (pair: Pair, id: ThreadId) =>
  MonitorSnapshot.parse((await pair.source.call({ op: "agents.status" })).data).children.find(
    (child) => child.id === id,
  );
const waitFor = async (pair: Pair, id: ThreadId, timeoutSeconds = 60) =>
  WaitResult.parse(
    (await pair.source.call({ op: "wait", threadIds: [id], mode: "all", timeoutSeconds })).data,
  );

/** The person on the target deletes the thread, as the app does there. */
async function deleteThere(pair: Pair, threadId: ThreadId) {
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const lifecycle = new ThreadLifecycle({
    store: pair.target.daemon.store,
    engine,
    handler: engine.handler,
    port: 0,
    hostId: "test",
    token: "unused",
    now: pair.target.h.clock.now,
  });
  const command = Command.parse({
    id: `person-delete-${threadId}`,
    deviceId: "person",
    // Its session may still be open after its turn ended; the person deletes it anyway.
    payload: { type: "thread.delete", threadId, force: true },
  });
  const deleted = await lifecycle.delete(command);
  if (!deleted.ok) throw new Error(JSON.stringify(deleted));
}

it("a child whose thread was deleted on the other machine gives its parent a final outcome, and a delayed message to it never runs", async () => {
  const gated = gatedTransport();
  const pair = await pairedMachines({ access: "operate", sourceTransport: gated.transport });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("first-pass"))).data).threadId;
  await pair.finishTask(child, "Do the first-pass part", "First pass done.");
  expect((await waitFor(pair, child)).threads[0]).toMatchObject({ state: "done" });

  // The person there deletes the thread. The parent's follow-up then has its first copy held on
  // the way while the caller hears its call dropped; the caller's retry is refused for good.
  await deleteThere(pair, child);
  gated.gate.failCaller = true;
  gated.gate.onlyFirst = true;
  gated.close();
  await expect(
    pair.source.call({
      op: "thread.message",
      threadId: child,
      requestId: "second",
      text: "Do a second pass",
    }),
  ).rejects.toMatchObject({ code: "invalid_arguments" });
  expect(gated.held()).toBe(1);

  // The child ends here with the deletion as its outcome, instead of waiting on the message.
  await eventually(async () =>
    expect((await waitFor(pair, child)).threads[0]).toMatchObject({
      state: "cancelled",
      result: "Its thread was deleted on that machine.",
    }),
  );

  // The delayed copy lands at last: it gets the same refusal and runs nothing.
  gated.open();
  await gated.arrived();
  await pair.target.daemon.engine?.flush();
  expect(pair.target.h.inputs.get(child) ?? []).not.toContain("Do a second pass");
  expect((await shownHere(pair, child))?.state).toBe("cancelled");
}, 90_000);

/** A child working there, then the person removes the machine here, as `ace remote remove`. */
async function unpairedChild(pair: Pair) {
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("long"))).data).threadId;
  await eventually(() =>
    expect((pair.target.h.inputs.get(child) ?? []).join("\n")).toContain("Do the long part"),
  );
  const parent = pair.source.caller.threadId;
  const asked = pair.requestIn(
    pair.source,
    parent,
    (interaction) =>
      interaction.request.kind === "approval" && interaction.request.title.startsWith("Lost:"),
  );
  const profiles = new Profiles(join(pair.source.h.home, "daemon"));
  const saved = profiles.get("studio");
  profiles.remove("studio");
  profiles.close();
  return { child, parent, ask: await asked, saved };
}

it("removing the pairing here leaves the parent unresolved and asking the person, and stopping tracking gives it the result", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const { child, parent, ask } = await unpairedChild(pair);
  expect(ask.request).toMatchObject({
    title: "Lost: Studio is no longer paired; its work there may still be running.",
  });

  // The child is lost, needing the person, and its parent is not done.
  const shown = await shownHere(pair, child);
  expect(shown).toMatchObject({ state: "needs_you", needs: 1 });
  expect(shown?.step).toContain("Lost: Studio");
  const waited = await waitFor(pair, child);
  expect(waited.status).toBe("needs_you");
  expect(waited.threads[0]).toMatchObject({ state: "needs_you" });
  expect(pair.source.daemon.store.getThread(parent)?.status.state).toBe("needs_you");

  // The person stops tracking it: only now does it settle, saying its work may still run.
  expect(pair.answer(ask, "stop-tracking").ok).toBe(true);
  const [ended] = (await waitFor(pair, child)).threads;
  expect(ended?.state).toBe("cancelled");
  expect(ended?.result).toContain("Its work there may still be running");
  expect(pair.target.daemon.store.getThread(child)?.status.state).toBe("working");
}, 60_000);

it("a lost child stays lost and asking the person across a restart here", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const { child, parent } = await unpairedChild(pair);
  await pair.restartSource();
  await eventually(async () => {
    const shown = await shownHere(pair, child);
    expect(shown).toMatchObject({ state: "needs_you", needs: 1 });
  });
  // The approval its parent shows is open, whether it survived the restart or opened again.
  await eventually(async () => {
    const [read] = (await waitFor(pair, child)).threads;
    const ask = read?.needs?.[0]?.interactionId;
    expect(ask && pair.source.daemon.store.getInteraction(ask)?.state).toBe("pending");
  });
  expect(pair.source.daemon.store.getThread(parent)?.status.state).not.toBe("done");
}, 60_000);

it("pairing the same device again resumes tracking a lost child, and its result reaches the parent", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const { child, parent, ask, saved } = await unpairedChild(pair);
  await pair.finish(child, "Finished while it was unpaired.");
  expect((await shownHere(pair, child))?.state).toBe("needs_you");

  const profiles = new Profiles(join(pair.source.h.home, "daemon"));
  const { id: _id, ...again } = saved;
  profiles.add(again);
  profiles.close();
  await eventually(() =>
    expect(pair.source.daemon.store.getInteraction(ask.id)?.state).toBe("expired"),
  );
  expect((await waitFor(pair, child)).threads[0]).toMatchObject({
    state: "done",
    result: "Finished while it was unpaired.",
  });
  expect(pair.source.daemon.store.getThread(parent)?.status.state).not.toBe("needs_you");
}, 60_000);

it("a child on a machine that turned agents off stays working here, and agents_status and wait say why", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("long"))).data).threadId;
  await eventually(() =>
    expect((pair.target.h.inputs.get(child) ?? []).join("\n")).toContain("Do the long part"),
  );
  await pair.access("off");

  await eventually(async () =>
    expect((await shownHere(pair, child))?.step).toBe(
      "Studio: agents from other machines are off there",
    ),
  );
  expect((await shownHere(pair, child))?.state).toBe("working");
  const waiting = waitFor(pair, child, 1);
  await new Promise((resolve) => setImmediate(resolve));
  pair.source.h.clock.advance(pair.source.h.clock.now() + 2_000);
  const waited = await waiting;
  expect(waited.status).toBe("timeout");
  expect(waited.threads[0]).toMatchObject({
    state: "working",
    step: "Studio: agents from other machines are off there",
  });
  expect(pair.source.daemon.store.getThread(pair.source.caller.threadId)?.status.state).not.toBe(
    "done",
  );
}, 60_000);

it("a refused message's record goes once its device is revoked there, and no copy from that device runs afterwards", async () => {
  const gated = gatedTransport();
  const pair = await pairedMachines({ access: "operate", sourceTransport: gated.transport });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("first-pass"))).data).threadId;
  await pair.finishTask(child, "Do the first-pass part", "First pass done.");
  expect((await waitFor(pair, child)).threads[0]).toMatchObject({ state: "done" });

  // Agents from the caller may only read there: the retry is refused and the refusal saved,
  // while the first copy is still held on its way.
  await pair.access("read");
  gated.gate.failCaller = true;
  gated.gate.onlyFirst = true;
  gated.close();
  await expect(
    pair.source.call({
      op: "thread.message",
      threadId: child,
      requestId: "second",
      text: "Do a second pass",
    }),
  ).rejects.toMatchObject({ code: "machine_forbidden" });
  const { store } = pair.target.daemon;
  const saved = () =>
    Number(store.statement("SELECT COUNT(*) AS n FROM machine_message_rejections").get()?.n);
  expect(saved()).toBe(1);

  await pair.access("operate");

  // The held copy lands and authenticates; while it waits in the access check, the person there
  // revokes the device. Its refusals go with it, and the copy is still never admitted.
  const { settings } = pair.target.daemon;
  const read = settings.get.bind(settings);
  let revoked = false;
  vi.spyOn(settings, "get").mockImplementation(async (...args: Parameters<typeof read>) => {
    if (!revoked && args[0] === "remote.agentAccess") {
      revoked = true;
      store.devices.revoke(pair.credential.device.id, pair.target.h.clock.now());
    }
    return read(...args);
  });
  gated.open();
  await gated.arrived();
  await pair.target.daemon.engine?.flush();
  expect(revoked).toBe(true);
  expect(saved()).toBe(0);
  expect(pair.target.h.inputs.get(child) ?? []).not.toContain("Do a second pass");
}, 90_000);
