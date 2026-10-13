import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ContextOperation, RemoteArtifactManifest } from "@ace/protocol";
import { RemotePublications } from "./remote-publication.ts";
import { remoteTarget } from "./remote-target-test-support.ts";

test("the first target completion seals text, usage and selected manifest before any broker poll or later local turn", async () => {
  const f = await remoteTarget();
  await writeFile(join(f.target.h.home, "result.txt"), "Original immutable file");
  const published = await f.target.controls.publications.publish(
    f.caller,
    { op: "device.task_publish", requestId: "publish", attachments: [], files: ["result.txt"] },
    new AbortController().signal,
  );
  expect(published.ok).toBe(true);
  const artifacts = RemoteArtifactManifest.parse(published.data);
  await f.emit({
    type: "usage",
    agent: "root",
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.25,
    counterMode: "cumulative",
    counterKey: "original",
  });
  await f.complete("Original delegated answer");
  expect(f.target.controls.publications.outcome(f.task.id)).toMatchObject({
    phase: "completed",
    result: "Original delegated answer",
    usage: { tokens: 15, cost: 0.25 },
    artifacts,
  });
  // No status query has run. Recreate the durable publication owner before the next turn.
  const recovered = new RemotePublications({
    store: f.target.daemon.store,
    engine: f.target.daemon.engine!,
    hostId: f.hostId,
  });
  expect(recovered.outcome(f.task.id)).toMatchObject({
    phase: "completed",
    result: "Original delegated answer",
    usage: { tokens: 15, cost: 0.25 },
    artifacts,
  });
  recovered.close();
  expect(
    f.target.controls.delegations.command("later-local-turn", {
      type: "thread.send",
      threadId: f.task.threadId,
      input: [{ type: "text", text: "Follow up locally" }],
      trigger: "user",
    }).ok,
  ).toBe(true);
  await f.target.daemon.engine?.flush();
  expect(f.target.daemon.store.getThread(f.task.threadId)?.status.state).toBe("working");
  expect(
    await f.request({
      type: "delegation.remote.status",
      requestId: "during-local-turn",
      taskId: f.task.id,
    }),
  ).toMatchObject({ ok: true, phase: "completed", result: "Original delegated answer", artifacts });
  await f.complete("Later local answer");
  expect(
    await f.request({
      type: "delegation.remote.status",
      requestId: "after-local-turn",
      taskId: f.task.id,
    }),
  ).toMatchObject({ ok: true, phase: "completed", result: "Original delegated answer", artifacts });
  expect(
    await f.request({
      type: "delegation.remote.cancel",
      requestId: "late-cancel",
      taskId: f.task.id,
    }),
  ).toMatchObject({ ok: true, phase: "completed", result: "Original delegated answer", artifacts });
});

test("a root turn ending does not seal while its task tree still owns live background work", async () => {
  const f = await remoteTarget();
  await f.emit({
    type: "background.started",
    agent: "root",
    task: "owned-shell",
    kind: "shell",
    title: "Background command",
    stoppable: true,
  });
  await f.complete("Root answer before shell completion");
  expect(f.target.controls.publications.outcome(f.task.id)).toBeUndefined();
  expect(
    await f.request({
      type: "delegation.remote.status",
      requestId: "waiting-shell",
      taskId: f.task.id,
    }),
  ).toMatchObject({ ok: true, phase: "waiting" });
  await f.emit({ type: "background.ended", task: "owned-shell", status: "completed" });
  expect(f.target.controls.publications.outcome(f.task.id)).toMatchObject({
    phase: "completed",
    result: "Root answer before shell completion",
  });
});

test("completion waits for an open human question before freezing an empty selected manifest", async () => {
  // A turn end cancels its own blocking questions (core cleanup), so the question that
  // outlives the answer is a non-blocking one the person still has to answer.
  const f = await remoteTarget();
  await f.emit({
    type: "interaction.opened",
    agent: "root",
    interaction: "approval",
    blocking: false,
    request: {
      kind: "question",
      questions: [
        {
          id: "choice",
          text: "Continue?",
          options: [{ id: "yes", label: "Yes" }],
          multiSelect: false,
          allowOther: false,
        },
      ],
    },
  });
  await f.complete("Answer awaiting approval");
  expect(
    await f.request({
      type: "delegation.remote.status",
      requestId: "needs-human",
      taskId: f.task.id,
    }),
  ).toMatchObject({ ok: true, phase: "waiting" });
  expect(f.target.controls.publications.outcome(f.task.id)).toBeUndefined();
  await f.emit({ type: "interaction.closed", interaction: "approval", state: "resolved" });
  expect(
    f.target.controls.delegations.command("human-follow-up", {
      type: "thread.send",
      threadId: f.task.threadId,
      input: [{ type: "text", text: "Follow up" }],
      trigger: "user",
    }).ok,
  ).toBe(true);
  await f.target.daemon.engine?.flush();
  const recovered = new RemotePublications({
    store: f.target.daemon.store,
    engine: f.target.daemon.engine!,
    hostId: f.hostId,
  });
  try {
    expect(recovered.outcome(f.task.id)).toMatchObject({
      phase: "completed",
      result: "Answer awaiting approval",
      artifacts: { attachments: [] },
    });
    expect(
      await f.request({
        type: "delegation.remote.status",
        requestId: "old-task",
        taskId: f.task.id,
      }),
    ).toMatchObject({ ok: true, phase: "completed", result: "Answer awaiting approval" });
  } finally {
    recovered.close();
  }
});

test("completion during an in-flight file publication retains its original answer through later local work", async () => {
  const f = await remoteTarget();
  await writeFile(join(f.target.h.home, "pending.txt"), "Original selected bytes");
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const uploads = f.target.daemon.context.uploads;
  const handle = uploads.handle.bind(uploads);
  const boundary = vi.spyOn(uploads, "handle").mockImplementation(async (...args) => {
    if (ContextOperation.parse(args[1]).op === "upload.begin") {
      entered?.();
      await gate;
    }
    return handle(...args);
  });
  const publication = f.target.controls.publications.publish(
    f.caller,
    { op: "device.task_publish", requestId: "publish", attachments: [], files: ["pending.txt"] },
    new AbortController().signal,
  );
  try {
    await started;
    await f.complete("Original answer during publication");
    expect(
      await f.request({
        type: "delegation.remote.status",
        requestId: "pending",
        taskId: f.task.id,
      }),
    ).toMatchObject({ ok: true, phase: "waiting" });
    expect(
      f.target.controls.delegations.command("local-follow-up", {
        type: "thread.send",
        threadId: f.task.threadId,
        input: [{ type: "text", text: "Continue locally" }],
        trigger: "user",
      }).ok,
    ).toBe(true);
    await f.target.daemon.engine?.flush();
    expect(
      await f.request({
        type: "delegation.remote.cancel",
        requestId: "late-cancel-pending",
        taskId: f.task.id,
      }),
    ).toMatchObject({ ok: true, phase: "waiting" });
    expect(f.target.daemon.store.getThread(f.task.threadId)?.status.state).toBe("working");
    await f.complete("Later local answer");
    release?.();
    const result = await publication;
    expect(result.ok).toBe(true);
    const artifacts = RemoteArtifactManifest.parse(result.data);
    expect(artifacts.attachments).toMatchObject([{ sourcePath: "pending.txt" }]);
    expect(
      await f.request({
        type: "delegation.remote.status",
        requestId: "finished",
        taskId: f.task.id,
      }),
    ).toMatchObject({
      ok: true,
      phase: "completed",
      result: "Original answer during publication",
      artifacts,
    });
  } finally {
    release?.();
    await publication;
    boundary.mockRestore();
  }
});
