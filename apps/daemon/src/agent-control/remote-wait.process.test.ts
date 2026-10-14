import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { RemoteAgentHost, RemoteTask, RemoteAgentOperation } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { RemoteDelegations } from "./remote.ts";

async function world(resolveArtifacts: (task: RemoteTask) => Promise<unknown>) {
  const f = setup();
  const caller = await f.parent();
  const remote = new RemoteDelegations({
    store: f.store,
    engine: f.engine,
    local: f.service,
    hostId: "source",
    now: f.clock.now,
    id: randomUUID,
    admit: () => true,
    resolveArtifacts,
    artifactReady: () => true,
  });
  const lease = remote.register(
    "broker",
    [
      RemoteAgentHost.parse({
        hostId: "target",
        name: "Target",
        projects: [{ workspaceId: "project", name: "Project" }],
        agents: [
          {
            provider: "codex",
            model: "model",
            accessModes: ["read-only", "ask", "auto-review", "full-access"],
          },
        ],
      }),
    ],
    () => true,
  );
  if (!lease) throw new Error("No lease");
  const brokerLease = lease;
  const result = await remote.execute(
    caller,
    RemoteAgentOperation.parse({
      op: "device.delegate",
      requestId: "work",
      hostId: "target",
      workspaceId: "project",
      provider: "codex",
      model: "model",
      task: "Review",
      role: "Reviewer",
    }),
    new AbortController().signal,
  );
  const task = RemoteTask.parse(result.data);
  remote.poll("broker", brokerLease);
  function complete() {
    remote.report("broker", brokerLease, {
      taskId: task.id,
      phase: "completed",
      result: "Owned remote answer",
      artifacts: {
        taskId: task.id,
        sourceHostId: task.sourceHostId,
        parentThreadId: task.parentThreadId,
        hostId: task.request.hostId,
        threadId: task.threadId,
        attachments: [
          { sha256: "a".repeat(64), bytes: 1, name: "result.txt", mimeType: "text/plain" },
        ],
      },
    });
  }
  const wait = (signal = new AbortController().signal) =>
    remote.execute(caller, { op: "device.task_wait", taskId: task.id }, signal);
  return { ...f, caller, remote, task, complete, wait };
}

test.each(["read failure", "abort"])(
  "remote waiter retains delivery until response preparation succeeds after %s",
  async (failure) => {
    const entered = Promise.withResolvers<void>();
    const files = Promise.withResolvers<unknown>();
    const f = await world(async () => {
      entered.resolve();
      return files.promise;
    });
    const controller = new AbortController();
    try {
      const pending = f.wait(controller.signal);
      const rejected = expect(pending).rejects.toThrow();
      f.complete();
      await entered.promise;
      expect(f.remote.journal.get(f.task.id)).toMatchObject({ delivered: false });
      expect(f.service.commandReceipt(`remote-result:${f.task.id}`)).toBeUndefined();
      if (failure === "abort") {
        controller.abort();
        files.resolve([]);
      } else files.reject(new Error("Temporary attachment read error"));
      await rejected;
      f.remote.close();
      const replacement = new RemoteDelegations({
        store: f.store,
        engine: f.engine,
        local: f.service,
        hostId: "source",
        now: f.clock.now,
        id: randomUUID,
        admit: () => true,
      });
      try {
        replacement.drain();
        replacement.drain();
        await f.engine.flush();
        expect(f.service.commandReceipt(`remote-result:${f.task.id}`)).toMatchObject({ ok: true });
        const results = f.store.readItemPage(f.caller.threadId, f.store.headSeq() + 1, 50).items;
        expect(
          results.filter(
            (item) =>
              item.type === "message" &&
              item.parts.some(
                (part) => part.type === "text" && part.text.includes("Owned remote answer"),
              ),
          ),
        ).toHaveLength(1);
      } finally {
        replacement.close();
      }
    } finally {
      files.resolve([]);
      controller.abort();
      f.remote.close();
    }
  },
);

test("a failed response cannot consume a concurrent surviving remote waiter", async () => {
  const firstFiles = Promise.withResolvers<unknown>();
  const firstEntered = Promise.withResolvers<void>();
  const secondFiles = Promise.withResolvers<unknown>();
  const secondEntered = Promise.withResolvers<void>();
  let reads = 0;
  const f = await world(async () => {
    if (++reads === 1) {
      firstEntered.resolve();
      return firstFiles.promise;
    }
    secondEntered.resolve();
    return secondFiles.promise;
  });
  try {
    const first = f.wait();
    const rejected = expect(first).rejects.toThrow("Temporary read error");
    const second = f.wait();
    f.complete();
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    firstFiles.reject(new Error("Temporary read error"));
    await rejected;
    f.remote.drain();
    expect(f.remote.journal.get(f.task.id)).toMatchObject({ delivered: false });
    expect(f.service.commandReceipt(`remote-result:${f.task.id}`)).toBeUndefined();
    secondFiles.resolve([{ path: "/owned/result.txt" }]);
    expect(await second).toMatchObject({
      ok: true,
      data: {
        result: "Owned remote answer",
        delivered: true,
        returnedFiles: [{ path: "/owned/result.txt" }],
      },
    });
    f.remote.drain();
    expect(f.service.commandReceipt(`remote-result:${f.task.id}`)).toBeUndefined();
  } finally {
    firstFiles.resolve([]);
    secondFiles.resolve([]);
    f.remote.close();
  }
});
