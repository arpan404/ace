import { join } from "node:path";
import { AutomationStore, type ExecutionInput } from "@ace/automations";
import { AgentAutomation, AutomationInbox, type Automation } from "@ace/protocol";
import { expect, test } from "vitest";
import { automationFixture } from "./automation-test-support.ts";

type Fixture = Awaited<ReturnType<typeof automationFixture>>;

const definition = (workspace: string): Automation => ({
  id: "older",
  title: "Older",
  enabled: true,
  workspace,
  provider: "claude",
  prompt: "Old task",
  worktree: false,
  trigger: { kind: "manual" },
  missedRun: "skip",
  concurrency: 1,
  jitterMs: 0,
});

/**
 * An automation with a run still going from before runs went into the agent's own thread:
 * the run is stored as running and its work is a delegated child, found by the run's key.
 */
async function olderRun(f: Fixture) {
  const automation = definition(f.h.home);
  expect(
    (
      await f.call({
        op: "automation.manage",
        request: {
          type: "automation.put",
          requestId: "put",
          automation: AgentAutomation.parse(automation),
        },
      })
    ).ok,
  ).toBe(true);
  const input: ExecutionInput = {
    idempotencyKey: "older-run",
    automationId: automation.id,
    provider: "claude",
    workspace: f.h.home,
    prompt: automation.prompt,
    worktree: false,
  };
  const store = new AutomationStore(join(f.dataDir, "agent-automations.sqlite"));
  try {
    store.transaction(() =>
      store.claim(
        automation,
        { key: "manual:older", variables: {} },
        "manual",
        input.idempotencyKey,
        f.h.clock.now(),
        input,
      ),
    );
  } finally {
    store.close();
  }
  const child = f.h.delegate(f.caller, input.idempotencyKey);
  await f.h.engine.flush();
  return child.childId;
}

const latest = async (f: Fixture) =>
  AutomationInbox.parse(
    (
      await f.call({
        op: "automation.manage",
        request: { type: "automation.inbox", requestId: "inbox", limit: 50 },
      })
    ).data,
  ).runs[0];

test("a run begun as a delegated child before an upgrade is followed to its end, never sent again", async () => {
  const f = await automationFixture();
  try {
    const child = await olderRun(f);
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    await f.h.engine.flush();
    expect(await latest(f)).toMatchObject({ id: "older-run", status: "running" });
    await f.h.complete(child, "The child finished the old task.");
    await expect
      .poll(() => latest(f))
      .toMatchObject({ status: "succeeded", result: "The child finished the old task." });
    // The run never went into the agent's own thread as well.
    expect(f.h.inputs.get(f.caller.threadId)).not.toContain("Old task");
  } finally {
    await f.close();
  }
});

test("pausing a run begun as a delegated child stops that child", async () => {
  const f = await automationFixture();
  try {
    const child = await olderRun(f);
    await f.settings.set("automations.enabled", true, { kind: "global" });
    await f.settings.settled({ kind: "global" });
    await f.h.engine.flush();
    expect(f.h.store.getThread(child)?.status.state).toBe("working");
    await f.call({
      op: "automation.manage",
      request: { type: "automation.setEnabled", requestId: "pause", id: "older", enabled: false },
    });
    await expect.poll(async () => (await latest(f))?.status).toBe("failed");
    expect(f.h.store.getThread(child)?.status.state).not.toBe("working");
    expect(f.h.inputs.get(f.caller.threadId)).not.toContain("Old task");
  } finally {
    await f.close();
  }
});

test("a stop asked for before a run's message is sent means it is never sent", async () => {
  const f = await automationFixture();
  try {
    const executor = f.executor();
    const input: ExecutionInput = {
      idempotencyKey: "never-sent",
      automationId: "paused-early",
      provider: "codex",
      workspace: f.h.home,
      prompt: "Never sent",
      worktree: false,
    };
    await executor.interrupt?.(input);
    await expect(executor.execute(input, new AbortController().signal)).rejects.toThrow(
      "Stopped before it started.",
    );
    await f.h.engine.flush();
    expect(f.h.inputs.get(f.caller.threadId)).not.toContain("Never sent");
    expect(f.h.engine.queue(f.caller.threadId).messages).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a stop asked for while a run is being sent still stops that run", async () => {
  const f = await automationFixture("claude");
  try {
    const executor = f.executor();
    const input: ExecutionInput = {
      idempotencyKey: "racing",
      automationId: "paused-racing",
      provider: "claude",
      workspace: f.h.home,
      prompt: "Racing the pause",
      worktree: false,
    };
    const running = executor.execute(input, new AbortController().signal);
    const stopped = executor.interrupt?.(input);
    const outcome = await running.then(
      (result) => result.result,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await stopped;
    expect(["Stopped before it started.", "Stopped before it finished."]).toContain(outcome);
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.caller.threadId)?.status.state).not.toBe("working");
  } finally {
    await f.close();
  }
});
