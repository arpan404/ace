import { join } from "node:path";
import { expect, test } from "vitest";
import { AgentControlOperation, ThreadId, type DelegationPolicy } from "@ace/protocol";
import { createAgentControlPort } from "@ace/daemon";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { question } from "../engine/test-support.ts";
import { createConversationStarts } from "./conversations.ts";
import { setup, wakes } from "./test-support.ts";

const signal = () => new AbortController().signal;
async function launch(policy: Partial<DelegationPolicy>) {
  const h = setup(policy);
  const caller = await h.parent();
  const runtime = new WorkspaceRuntime(h.store, join(h.home, "owned"), h.clock.now);
  const port = createAgentControlPort(h.store, h.service, {
    startConversation: createConversationStarts(
      { store: h.store, services: { workspaceActions: runtime }, signal: signal() },
      h.service,
      h.service.conversations,
    ),
  });
  const result = await port.execute(
    caller,
    AgentControlOperation.parse({
      op: "thread.start",
      requestId: "budgeted",
      title: "Ordinary work",
      text: "Work",
      provider: "claude",
      workspace: { kind: "project" },
    }),
    signal(),
  );
  expect(result.ok).toBe(true);
  const thread = h.store.listThreads().find((row) => row.id !== caller.threadId);
  if (!thread) throw new Error("Conversation missing");
  await h.engine.flush();
  return { h, caller, thread: thread.id, runtime };
}
const message = (
  threadId: ThreadId,
  requestId: string,
  delivery: "queue" | "steer" | "restart" = "queue",
) =>
  AgentControlOperation.parse({
    op: "thread.message",
    threadId,
    requestId,
    text: "More work",
    delivery,
  });

for (const [budget, policy, finalUsage] of [
  ["tokens", { tokens: 100 }, { inputTokens: 80, outputTokens: 20, costUsd: 4 }],
  ["cost", { cost: 10 }, { inputTokens: 30, outputTokens: 20, costUsd: 10 }],
] as const) {
  test(`ordinary conversation ${budget} accounting survives completed turns and SQLite restart, and refuses every follow-up mode after exhaustion`, async () => {
    const { h, caller, thread, runtime } = await launch(policy);
    try {
      const sample = {
        type: "usage",
        agent: "root",
        inputTokens: 30,
        outputTokens: 20,
        costUsd: 4,
        counterMode: "cumulative",
        counterKey: "session",
      } as const;
      await h.emit(thread, sample, sample);
      expect(h.store.getThread(thread)?.status.state).toBe("working");
      await h.complete(thread, "First result");
      expect(
        (
          await createAgentControlPort(h.store, h.service).execute(
            caller,
            message(thread, "second-turn"),
            signal(),
          )
        ).ok,
      ).toBe(true);
      await h.engine.flush();
      await h.emit(thread, { ...sample, ...finalUsage });
      expect(h.store.getThread(thread)?.status.state).toBe("done");
      expect(wakes(h.events, caller.threadId)).toHaveLength(0);
      const inputs = h.inputs.get(thread)?.length;
      for (const delivery of ["queue", "steer", "restart"] as const)
        expect(
          await createAgentControlPort(h.store, h.service).execute(
            caller,
            message(thread, `over-${delivery}`, delivery),
            signal(),
          ),
        ).toMatchObject({ ok: false });
      await h.engine.flush();
      expect(h.inputs.get(thread)).toHaveLength(inputs ?? 0);
      await runtime.close();
      await h.close();
      const reopened = setup(policy, h.dbPath);
      for (const delivery of ["queue", "steer", "restart"] as const)
        expect(
          await createAgentControlPort(reopened.store, reopened.service).execute(
            reopened.caller(caller.threadId),
            message(thread, `reopened-${delivery}`, delivery),
            signal(),
          ),
        ).toMatchObject({ ok: false });
      await reopened.engine.flush();
      expect(reopened.inputs.get(thread)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
}

test("a silent ordinary conversation retains its original deadline through admission-owner restart", async () => {
  const { h, caller, thread, runtime } = await launch({ durationMs: 100 });
  try {
    await h.emit(thread, question);
    expect(h.store.getThread(thread)?.status.state).toBe("needs_you");
    await h.complete(caller.threadId, "Caller finished independently");
    expect(h.store.getThread(caller.threadId)?.status.state).toBe("done");
    h.clock.advance(1050);
    h.restartOwner();
    h.clock.advance(1100);
    await h.engine.flush();
    expect(h.store.getThread(thread)?.status.state).toBe("done");
    expect(h.errors).toEqual([]);
    expect(wakes(h.events, caller.threadId)).toHaveLength(0);
    expect(
      await createAgentControlPort(h.store, h.service).execute(
        caller,
        message(thread, "expired"),
        signal(),
      ),
    ).toMatchObject({ ok: false });
    expect(h.inputs.get(thread)).toEqual(["Work"]);
  } finally {
    await runtime.close();
  }
});

test("conversation follow-ups reacquire deadline ownership without extending the original budget", async () => {
  const { h, caller, thread, runtime } = await launch({ durationMs: 100 });
  try {
    await h.complete(thread, "Result");
    h.clock.advance(1050);
    h.restartOwner();
    expect(
      (
        await createAgentControlPort(h.store, h.service).execute(
          caller,
          message(thread, "reopened"),
          signal(),
        )
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    h.clock.advance(1100);
    await h.engine.flush();
    expect(h.store.getThread(thread)?.status.state).toBe("done");
    expect(h.inputs.get(thread)).toEqual(["Work", "More work"]);
    expect(
      await createAgentControlPort(h.store, h.service).execute(
        caller,
        message(thread, "expired"),
        signal(),
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await runtime.close();
  }
});

test("a conversation's child usage spends the caller's shared budget and siblings gain no write authority", async () => {
  const { h, caller, thread, runtime } = await launch({ tokens: 100 });
  try {
    const worker = h.delegate(h.caller(thread), "worker");
    const sibling = h.delegate(caller, "sibling");
    await h.engine.flush();
    const port = createAgentControlPort(h.store, h.service);
    expect(
      await port.execute(h.caller(sibling.childId), message(worker.childId, "forbidden"), signal()),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect((await port.execute(caller, message(worker.childId, "owned"), signal())).ok).toBe(true);
    await h.emit(thread, {
      type: "usage",
      agent: "root",
      inputTokens: 40,
      outputTokens: 0,
      counterMode: "cumulative",
      counterKey: "session",
    });
    await h.emit(worker.childId, {
      type: "usage",
      agent: "root",
      inputTokens: 60,
      outputTokens: 0,
      counterMode: "cumulative",
      counterKey: "session",
    });
    for (const id of [thread, worker.childId, sibling.childId])
      expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(await port.execute(caller, message(thread, "spent"), signal())).toMatchObject({
      ok: false,
    });
    expect(() => h.delegate(h.caller(thread), "spent-child")).toThrow();
  } finally {
    await runtime.close();
  }
});

test("SQLite restart preserves partial conversation usage and deduplicates the same cumulative sample", async () => {
  const { h, caller, thread, runtime } = await launch({ tokens: 100 });
  const sample = {
    type: "usage",
    agent: "root",
    inputTokens: 30,
    outputTokens: 20,
    counterMode: "cumulative",
    counterKey: "session",
  } as const;
  await h.emit(thread, sample);
  await h.complete(thread, "Saved partial budget");
  await runtime.close();
  await h.close();
  const reopened = setup({ tokens: 100 }, h.dbPath);
  const port = createAgentControlPort(reopened.store, reopened.service);
  expect(
    (
      await port.execute(
        reopened.caller(caller.threadId),
        message(thread, "resume-partial"),
        signal(),
      )
    ).ok,
  ).toBe(true);
  await reopened.engine.flush();
  await reopened.emit(thread, sample, sample);
  expect(reopened.store.getThread(thread)?.status.state).toBe("working");
  await reopened.emit(thread, { ...sample, inputTokens: 80 });
  expect(reopened.store.getThread(thread)?.status.state).toBe("done");
  expect(
    await port.execute(reopened.caller(caller.threadId), message(thread, "exhausted"), signal()),
  ).toMatchObject({ ok: false });
});

test("stopping the caller leaves ordinary work independent but cannot disable its deadline", async () => {
  const { h, caller, thread, runtime } = await launch({ durationMs: 100 });
  try {
    expect(
      h.service.command("stop-owner", {
        type: "thread.interrupt",
        threadId: caller.threadId,
        cascade: true,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(h.store.getThread(thread)?.status.state).toBe("working");
    h.restartOwner();
    h.clock.advance(1100);
    await h.engine.flush();
    expect(h.store.getThread(thread)?.status.state).toBe("done");
    expect(h.errors).toEqual([]);
    expect(
      await createAgentControlPort(h.store, h.service).execute(
        caller,
        message(thread, "expired-after-owner-stop"),
        signal(),
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await runtime.close();
  }
});

test("a reopened SQLite conversation spends only the time left on its persisted deadline", async () => {
  const { h, caller, thread, runtime } = await launch({ durationMs: 100 });
  await h.complete(thread, "Persisted result");
  await runtime.close();
  await h.close();
  const reopened = setup({ durationMs: 100 }, h.dbPath);
  reopened.clock.advance(1050);
  const port = createAgentControlPort(reopened.store, reopened.service);
  expect(
    (
      await port.execute(
        reopened.caller(caller.threadId),
        message(thread, "within-deadline"),
        signal(),
      )
    ).ok,
  ).toBe(true);
  await reopened.engine.flush();
  reopened.clock.advance(1100);
  await reopened.engine.flush();
  expect(reopened.store.getThread(thread)?.status.state).toBe("done");
  expect(
    await port.execute(
      reopened.caller(caller.threadId),
      message(thread, "past-deadline"),
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(reopened.inputs.get(thread)).toEqual(["More work"]);
});
