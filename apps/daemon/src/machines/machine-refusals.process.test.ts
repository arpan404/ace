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

it("removing the pairing here ends a child still working there with a lost result its parent gets", async () => {
  const pair = await pairedMachines({ access: "operate" });
  await pair.source.call({ op: "machines" });
  const child = Delegated.parse((await pair.source.call(task("long"))).data).threadId;
  await eventually(() =>
    expect((pair.target.h.inputs.get(child) ?? []).join("\n")).toContain("Do the long part"),
  );
  expect((await shownHere(pair, child))?.state).toBe("working");

  // The person removes the other machine here, as `ace remote remove studio` does.
  const profiles = new Profiles(join(pair.source.h.home, "daemon"));
  profiles.remove("studio");
  profiles.close();

  const [ended] = (await waitFor(pair, child)).threads;
  expect(ended?.state).toBe("failed");
  expect(ended?.result).toContain("no longer paired");
  expect(pair.target.daemon.store.getThread(child)?.status.state).toBe("working");
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
