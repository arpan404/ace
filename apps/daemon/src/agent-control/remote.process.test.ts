import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AgentId,
  RemoteContextManifest,
  RemoteAgentHost,
  RemoteAgentOperation,
  RemoteTask,
} from "@ace/protocol";
import { setup } from "./test-support.ts";
import { RemoteDelegations } from "./remote.ts";

const owners: RemoteDelegations[] = [];
afterEach(() => owners.splice(0).forEach((owner) => owner.close()));
async function world(
  hostId = "source",
  prepareContext?: ConstructorParameters<typeof RemoteDelegations>[0]["prepareContext"],
) {
  const f = setup();
  const caller = await f.parent();
  const remote = new RemoteDelegations({
    ...(prepareContext ? { prepareContext } : {}),
    clock: f.clock,
    hostId,
    store: f.store,
    engine: f.engine,
    local: f.service,
    now: f.clock.now,
    id: randomUUID,
    admit: () => true,
  });
  owners.push(remote);
  f.service.onRemoteCancel = (thread) => remote.cancelTree(thread);
  const host = RemoteAgentHost.parse({
    hostId: "target",
    name: "Target",
    projects: [{ workspaceId: "project", name: "Project" }],
    agents: [
      {
        provider: "codex",
        model: "model",
        accountId: "account",
        permissionModes: [
          {
            id: f.engine.permissionMode(caller.threadId) ?? ":read-only",
            label: "Safe",
            description: "Safe",
            risk: "low",
          },
          { id: "unsafe", label: "Unsafe", description: "Unsafe", risk: "high" },
        ],
      },
    ],
  });
  const lease = remote.register("window", [host], () => true)!;
  const operation = RemoteAgentOperation.options[1].parse({
    op: "device.delegate",
    requestId: "work",
    hostId: "target",
    workspaceId: "project",
    provider: "codex",
    model: "model",
    accountId: "account",
    role: "Review",
    task: "Review code",
  });
  async function delegate() {
    const result = await remote.execute(caller, operation, new AbortController().signal);
    expect(
      result.ok,
      JSON.stringify({
        result,
        parent: f.store.getThread(caller.threadId)?.permission,
        mode: f.engine.permissionMode(caller.threadId),
      }),
    ).toBe(true);
    return RemoteTask.parse(result.data);
  }
  return { ...f, caller, remote, lease, operation, delegate };
}

test("agents discover explicit host projects and delegate idempotently without starting a local child", async () => {
  const f = await world();
  expect(
    await f.remote.execute(f.caller, { op: "device.list" }, new AbortController().signal),
  ).toMatchObject({ ok: true, data: { hosts: [{ hostId: "target" }] } });
  const task = await f.delegate();
  expect(await f.delegate()).toEqual(task);
  expect(f.store.listThreads()).toHaveLength(1);
  expect(f.store.getThread(f.caller.threadId)?.status).toEqual({
    state: "waiting",
    on: "background_task",
  });
  expect(
    await f.remote.execute(
      f.caller,
      { ...f.operation, task: "Different" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, code: "invalid" });
  expect(
    await f.remote.execute(
      { ...f.caller, agentId: AgentId.parse("impostor") },
      f.operation,
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, code: "forbidden" });
  expect(
    await f.remote.execute(
      f.caller,
      { ...f.operation, requestId: "unsafe", permissionMode: "unsafe" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, code: "forbidden" });
});

test("live remote work holds the parent through provider exit; bounded result wakes it only once", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  await f.emit(f.caller.threadId, { type: "process.exited", deliberate: false });
  expect(f.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
  f.remote.report("window", f.lease, { taskId: task.id, phase: "waiting" });
  expect(f.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
  const finished = f.remote.report("window", f.lease, {
    taskId: task.id,
    phase: "completed",
    result: "Reviewed remotely",
  });
  expect(finished).toMatchObject({ phase: "completed", delivered: true });
  const received = f.events.filter(
    (event) =>
      event.payload.type === "item.created" &&
      event.payload.item.type === "message" &&
      event.payload.item.parts.some(
        (part) => part.type === "text" && part.text.includes("Reviewed remotely"),
      ),
  ).length;
  f.remote.report("window", f.lease, { taskId: task.id, phase: "completed", result: "Duplicate" });
  expect(
    f.events.filter(
      (event) =>
        event.payload.type === "item.created" &&
        event.payload.item.type === "message" &&
        event.payload.item.parts.some(
          (part) => part.type === "text" && part.text.includes("Reviewed remotely"),
        ),
    ),
  ).toHaveLength(received);
});

test("cancellation before claim never dispatches; stale broker completion cannot undo in-flight cancellation", async () => {
  const f = await world();
  const task = await f.delegate();
  await f.remote.execute(
    f.caller,
    { op: "device.task_cancel", taskId: task.id },
    new AbortController().signal,
  );
  expect(f.remote.poll("window", f.lease)).toEqual([]);
  expect(f.remote.journal.get(task.id)).toMatchObject({ phase: "cancelled", dispatched: false });
  const second = await f.remote.execute(
    f.caller,
    { ...f.operation, requestId: "second" },
    new AbortController().signal,
  );
  const claimed = RemoteTask.parse(second.data);
  f.remote.poll("window", f.lease);
  await f.remote.execute(
    f.caller,
    { op: "device.task_cancel", taskId: claimed.id },
    new AbortController().signal,
  );
  f.remote.disconnect("window");
  expect(
    f.remote.report("window", f.lease, { taskId: claimed.id, phase: "completed" }),
  ).toBeUndefined();
  const lease = f.remote.register("replacement", [], () => true)!;
  expect(
    f.remote.report("replacement", lease, { taskId: claimed.id, phase: "completed" }),
  ).toMatchObject({ phase: "cancelling" });
  expect(
    f.remote.report("replacement", lease, { taskId: claimed.id, phase: "cancelled" }),
  ).toMatchObject({ phase: "cancelled", delivered: true });
});

test("durable ledger survives owner recreation; source hosts namespace otherwise identical requests", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.disconnect("window");
  const replacement = new RemoteDelegations({
    hostId: "source",
    store: f.store,
    engine: f.engine,
    local: f.service,
    now: f.clock.now,
    id: randomUUID,
    admit: () => true,
  });
  const lease = replacement.register("new", [], () => true)!;
  expect(replacement.poll("new", lease)).toMatchObject([{ id: task.id, threadId: task.threadId }]);
  expect(f.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
  const other = new RemoteDelegations({
    hostId: "another-source",
    store: f.store,
    engine: f.engine,
    local: f.service,
    now: f.clock.now,
    id: randomUUID,
    admit: () => true,
  });
  const hosts = (
    await replacement.execute(f.caller, { op: "device.list" }, new AbortController().signal)
  ).data;
  expect(hosts).toMatchObject({ hosts: [] });
  const initial = f.remote.register(
    "window",
    [
      RemoteAgentHost.parse({
        hostId: "target",
        name: "Target",
        projects: [{ workspaceId: "project", name: "Project" }],
        agents: [
          {
            provider: "codex",
            model: "model",
            accountId: "account",
            permissionModes: [
              {
                id: f.engine.permissionMode(f.caller.threadId) ?? ":read-only",
                label: "Safe",
                description: "Safe",
                risk: "low",
              },
            ],
          },
        ],
      }),
    ],
    () => true,
  )!;
  const list = await f.remote.execute(
    f.caller,
    { op: "device.list" },
    new AbortController().signal,
  );
  const parsed = RemoteAgentHost.array().parse((list.data as { hosts: unknown }).hosts);
  other.register("other", parsed, () => true);
  const result = await other.execute(f.caller, f.operation, new AbortController().signal);
  expect(RemoteTask.parse(result.data).id).not.toBe(task.id);
  expect(initial).toBeTruthy();
});

test("permission changes before admission cancel queued work; remote roots cannot delegate to another device", async () => {
  const f = await world();
  const task = await f.delegate();
  expect(
    f.service.command("narrow-parent", {
      type: "thread.permission.set",
      threadId: f.caller.threadId,
      permissionMode: "full-access",
    }).ok,
  ).toBe(true);
  expect(f.remote.poll("window", f.lease)).toMatchObject([
    { id: task.id, phase: "cancelled", dispatched: false },
  ]);
  f.store.atomic((db) => {
    db.exec("CREATE TABLE remote_agent_incoming(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL)");
    db.prepare("INSERT INTO remote_agent_incoming VALUES (?,?)").run("incoming", f.caller.threadId);
  });
  expect(
    await f.remote.execute(
      f.caller,
      { ...f.operation, requestId: "recursive" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, code: "forbidden" });
});

test("two waiting callers retain result ownership when one aborts", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  const first = new AbortController();
  const waiting = f.remote.execute(
    f.caller,
    { op: "device.task_wait", taskId: task.id },
    first.signal,
  );
  const rejected = expect(waiting).rejects.toThrow();
  const surviving = f.remote.execute(
    f.caller,
    { op: "device.task_wait", taskId: task.id },
    new AbortController().signal,
  );
  first.abort();
  await rejected;
  f.remote.report("window", f.lease, {
    taskId: task.id,
    phase: "completed",
    result: "Surviving waiter owns this",
  });
  expect(await surviving).toMatchObject({
    ok: true,
    data: { phase: "completed", result: "Surviving waiter owns this" },
  });
  expect(f.store.getThread(f.caller.threadId)?.queue?.pendingCount).toBe(0);
});

test("Stop during async context preparation prevents durable admission", async () => {
  let ready!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => (entered = resolve));
  const barrier = new Promise<void>((resolve) => (ready = resolve));
  const f = await world("source", async (task) => {
    entered();
    await barrier;
    return RemoteContextManifest.parse({
      sourceHostId: task.sourceHostId,
      sourceThreadId: task.parentThreadId,
      summary: "Snapshot",
      before: null,
      attachments: [],
    });
  });
  const pending = f.remote.execute(f.caller, f.operation, new AbortController().signal);
  await opened;
  f.service.cancelDescendants(f.caller.threadId);
  ready();
  expect(await pending).toMatchObject({ ok: false, code: "limit" });
  expect(f.remote.journal.count()).toBe(0);
});

test("offline deadlines cancel unclaimed work and fence dispatched work until remote acknowledgement", async () => {
  const f = await world();
  const first = await f.delegate();
  const second = RemoteTask.parse(
    (
      await f.remote.execute(
        f.caller,
        { ...f.operation, requestId: "second" },
        new AbortController().signal,
      )
    ).data,
  );
  // Claim the second only to model a disconnected target with an already accepted run.
  second.dispatched = true;
  f.remote.journal.save(second);
  f.remote.disconnect("window");
  f.clock.advance(f.clock.now() + f.service.policy.durationMs + 1000);
  expect(f.remote.journal.get(first.id)).toMatchObject({ phase: "cancelled", delivered: true });
  expect(f.remote.journal.get(second.id)).toMatchObject({ phase: "cancelling", delivered: false });
  expect(f.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
});

test("rejected parent result delivery rolls back its receipt and retries safely", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  const handler = vi.spyOn(f.engine.internalHandler, "handle");
  handler.mockImplementationOnce((command) => ({
    commandId: command.id,
    ok: false,
    error: "queue_capacity_exceeded",
  }));
  expect(
    f.remote.report("window", f.lease, { taskId: task.id, phase: "completed", result: "Ready" }),
  ).toMatchObject({ phase: "completed", delivered: false });
  expect(f.service.commandReceipt(`remote-result:${task.id}`)).toBeUndefined();
  f.clock.advance(f.clock.now() + 5000);
  f.remote.drain();
  expect(f.remote.journal.get(task.id)).toMatchObject({ delivered: true });
  expect(f.service.commandReceipt(`remote-result:${task.id}`)).toMatchObject({ ok: true });
  handler.mockRestore();
});

test("an offline dispatched cancellation ends with an explicit unknown remote state", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  await f.remote.execute(
    f.caller,
    { op: "device.task_cancel", taskId: task.id },
    new AbortController().signal,
  );
  f.remote.disconnect("window");
  f.clock.advance(f.clock.now() + 30000);
  f.remote.drain();
  expect(f.remote.journal.get(task.id)).toMatchObject({
    phase: "failed",
    delivered: true,
    error: expect.stringContaining("may still be running"),
  });
  expect(
    Object.values(f.store.snapshotThread(f.caller.threadId).backgroundTasks).some(
      (background) => background.status === "running",
    ),
  ).toBe(false);
});

test("the parent background row can stop a dispatched remote task", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  const background = Object.values(f.store.snapshotThread(f.caller.threadId).backgroundTasks).find(
    (candidate) => candidate.kind === "subagent",
  );
  expect(background?.stoppable).toBe(true);
  if (!background) throw new Error("No background row");
  expect(
    f.service.command("stop-remote-row", { type: "background_task.stop", taskId: background.id })
      .ok,
  ).toBe(true);
  expect(f.remote.journal.get(task.id)?.phase).toBe("cancelling");
});

test("sealed text and its truncation marker survive a cancellation race and missing files", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  f.remote.stopTask(task.id);
  f.remote.report("window", f.lease, {
    taskId: task.id,
    phase: "completed",
    result: "Sealed answer",
    truncated: true,
    artifactsUnavailable: true,
    error: "Files could not be imported",
  });
  f.remote.report("window", f.lease, { taskId: task.id, phase: "cancelled" });
  const messages = f.events.flatMap((event) =>
    event.payload.type === "item.created" && event.payload.item.type === "message"
      ? event.payload.item.parts
      : [],
  );
  expect(
    messages.some(
      (part) =>
        part.type === "text" &&
        part.text.includes("Sealed answer") &&
        part.text.includes("truncated") &&
        part.text.includes("Files could not"),
    ),
  ).toBe(true);
});

test("one rejected result does not stall another task and retries after its own backoff", async () => {
  const f = await world();
  const first = await f.delegate();
  const second = RemoteTask.parse(
    (
      await f.remote.execute(
        f.caller,
        { ...f.operation, requestId: "second" },
        new AbortController().signal,
      )
    ).data,
  );
  f.remote.poll("window", f.lease);
  const original = f.engine.internalHandler.handle;
  const handler = vi
    .spyOn(f.engine.internalHandler, "handle")
    .mockImplementation((command, context) =>
      command.id === `remote-result:${first.id}`
        ? { commandId: command.id, ok: false, error: "queue_capacity_exceeded" }
        : original(command, context),
    );
  f.remote.report("window", f.lease, { taskId: first.id, phase: "completed", result: "First" });
  expect(
    f.remote.report("window", f.lease, { taskId: second.id, phase: "completed", result: "Second" }),
  ).toMatchObject({ delivered: true });
  expect(f.remote.poll("window", f.lease)).toHaveLength(1);
  handler.mockRestore();
  f.clock.advance(f.clock.now() + 5000);
  f.remote.drain();
  expect(f.remote.journal.active()).toEqual([]);
  expect(f.service.commandReceipt(`remote-result:${first.id}`)).toMatchObject({ ok: true });
});

test("old delivered tasks expire while undelivered work remains available", async () => {
  const f = await world();
  const task = await f.delegate();
  f.remote.poll("window", f.lease);
  f.remote.report("window", f.lease, { taskId: task.id, phase: "completed", result: "Finished" });
  await f.emit(f.caller.threadId, { type: "process.exited", deliberate: false });
  f.clock.advance(f.clock.now() + 8 * 24 * 60 * 60 * 1000);
  f.remote.drain();
  expect(f.remote.journal.get(task.id)).toBeUndefined();
});

test("ten thousand historical tasks do not prevent a new delegation", async () => {
  const f = await world();
  const first = await f.delegate();
  f.remote.poll("window", f.lease);
  f.remote.report("window", f.lease, { taskId: first.id, phase: "completed", result: "Finished" });
  f.store.atomic(() => {
    for (let index = 0; index < 10000; index++)
      f.remote.journal.save(
        RemoteTask.parse({
          ...first,
          id: index.toString(16).padStart(64, "0"),
          rootThreadId: "historical-root",
          phase: "completed",
          delivered: true,
        }),
      );
  });
  const next = await f.remote.execute(
    f.caller,
    { ...f.operation, requestId: "after-history" },
    new AbortController().signal,
  );
  expect(next).toMatchObject({ ok: true, data: { phase: "queued" } });
});
