import { expect, test } from "vitest";
import { z } from "zod";
import { Automation, Command, ThreadId } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { connectAutomations } from "./automation-socket-test-support.ts";

const definition = (workspace: string, patch: Partial<Automation> = {}): Automation =>
  Automation.parse({
    id: "agent-nightly",
    title: "Nightly check",
    enabled: true,
    workspace,
    provider: "claude",
    prompt: "Check the build",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
    ...patch,
  });

/** An agent in the fixture's parent thread saves an automation, as it does over MCP. */
async function agentPuts(f: Awaited<ReturnType<typeof daemonFixture>>, automation: Automation) {
  const saved = await f.call({
    op: "automation.manage",
    request: { type: "automation.put", requestId: `put-${automation.id}`, automation },
  });
  expect(saved.ok).toBe(true);
}

test("the app lists an agent's automation with its thread and pauses and deletes it", async () => {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "thread-automations");
  try {
    const automation = definition(f.h.home);
    await agentPuts(f, automation);
    const plain = await app.ask({ type: "automation.list", requestId: "plain" });
    expect(plain.automations).toEqual([]);
    expect(plain.threadAutomations).toBeUndefined();
    const listed = await app.ask({
      type: "automation.list",
      requestId: "with-threads",
      includeThreads: true,
    });
    expect(listed.threadAutomations).toEqual([
      expect.objectContaining({ automation, threadId: f.caller.threadId, nextRunAt: null }),
    ]);
    const revision = z.number().int().positive().parse(listed.threadAutomations?.[0]?.revision);
    expect(
      await app.ask({
        type: "automation.setEnabled",
        requestId: "pause-as-person",
        id: automation.id,
        enabled: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await app.ask({
        type: "automation.setEnabled",
        requestId: "pause",
        id: automation.id,
        enabled: false,
        expectedRevision: revision,
        source: "thread",
      }),
    ).toMatchObject({ ok: true });
    const stale = await app.ask({
      type: "automation.setEnabled",
      requestId: "stale-resume",
      id: automation.id,
      enabled: true,
      expectedRevision: revision,
      source: "thread",
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/conflict/i);
    const paused = await app.ask({
      type: "automation.list",
      requestId: "paused",
      includeThreads: true,
    });
    expect(paused.threadAutomations?.[0]?.automation.enabled).toBe(false);
    expect(
      await app.ask({
        type: "automation.remove",
        requestId: "remove",
        id: automation.id,
        source: "thread",
      }),
    ).toMatchObject({ ok: true });
    const removed = await app.ask({
      type: "automation.list",
      requestId: "removed",
      includeThreads: true,
    });
    expect(removed.threadAutomations).toEqual([]);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("an automation leaves the app's list once the thread that made it is deleted", async () => {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "deleted-owner");
  try {
    await agentPuts(f, definition(f.h.home));
    app.client.send({
      type: "command",
      command: Command.parse({
        id: "delete-owner",
        deviceId: "deleted-owner",
        payload: { type: "thread.delete", threadId: f.caller.threadId, force: true },
      }),
    });
    for (;;) {
      const reply = await app.client.next();
      if (reply.type === "commandResult" && reply.commandId === "delete-owner") {
        expect(reply).toMatchObject({ ok: true });
        break;
      }
    }
    await expect
      .poll(() => f.daemon.store.getThread(f.caller.threadId)?.deletedAt !== undefined)
      .toBe(true);
    const listed = await app.ask({
      type: "automation.list",
      requestId: "after-delete",
      includeThreads: true,
    });
    expect(listed.threadAutomations).toEqual([]);
    expect(
      await app.ask({
        type: "automation.run",
        requestId: "run-orphan",
        id: "agent-nightly",
        variables: {},
        source: "thread",
      }),
    ).toMatchObject({ ok: false, error: "not_found" });
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a thread automation run from the app goes into its own thread with the person's note, keeping the thread's effort", async () => {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "thread-run");
  try {
    await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
    const automation = definition(f.h.home, { effort: "high" });
    await agentPuts(f, automation);
    const ask = () =>
      app.ask({
        type: "automation.run",
        requestId: "noted-run",
        id: automation.id,
        variables: {},
        message: "Only the checkout tests",
        source: "thread",
      });
    const admitted = await ask();
    expect(admitted).toMatchObject({ ok: true, run: { status: "running" } });
    const runId = z.string().parse(admitted.run?.id);
    // The run is one more message in the thread that made it, not a thread of its own.
    const owner = f.caller.threadId;
    await expect
      .poll(() => f.h.inputs.get(owner)?.join("\n"))
      .toContain("Check the build\n\nOnly the checkout tests");
    // The agent's thread keeps the effort it runs at, not the automation's saved one.
    expect(f.h.contexts.get(owner)?.options?.effort).not.toBe("high");
    expect((await ask()).run?.id).toBe(runId);
    const history = await app.ask({
      type: "automation.inbox",
      requestId: "history",
      automationId: automation.id,
      limit: 10,
      source: "thread",
    });
    expect(history.inbox?.runs.map((run) => run.id)).toEqual([runId]);
    const personHistory = await app.ask({
      type: "automation.inbox",
      requestId: "person-history",
      limit: 10,
    });
    expect(personHistory.inbox?.runs).toEqual([]);
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});

test("a person automation starts its thread on the saved effort and account", async () => {
  const f = await daemonFixture();
  const app = await connectAutomations(f, "launch-choices");
  try {
    await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
    const automation = definition(f.h.home, {
      id: "person-launch",
      title: "Launch choices",
      effort: "high",
      instance: "claude-cli-default",
    });
    expect(await app.ask({ type: "automation.put", requestId: "put", automation })).toMatchObject({
      ok: true,
    });
    expect(
      await app.ask({
        type: "automation.run",
        requestId: "run",
        id: automation.id,
        variables: {},
        message: "Focus on flaky tests",
      }),
    ).toMatchObject({ ok: true, run: { status: "running" } });
    const started = () =>
      f.daemon.store.listThreads().find((thread) => thread.title === "Automation: Launch choices")
        ?.id;
    await expect.poll(started).toBeDefined();
    const threadId = ThreadId.parse(started());
    await expect.poll(() => f.h.contexts.has(threadId)).toBe(true);
    expect(f.h.contexts.get(threadId)).toMatchObject({
      instanceId: "claude-cli-default",
      options: { effort: "high" },
    });
    await expect
      .poll(() => f.h.inputs.get(threadId)?.join("\n"))
      .toContain("Check the build\n\nFocus on flaky tests");
  } finally {
    await app.client.close();
    await f.daemon.close();
  }
});
