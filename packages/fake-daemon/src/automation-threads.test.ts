import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, ThreadId, type Automation } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function fixture() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return { daemon, client };
}

const owned: Automation = {
  id: "agent-soak",
  title: "Soak the checkout test",
  enabled: true,
  workspace: "workspace",
  provider: "claude",
  effort: "high",
  prompt: "Run the checkout test 25 times",
  worktree: false,
  trigger: { kind: "manual" },
  missedRun: "skip",
  concurrency: 1,
  jitterMs: 0,
};

/** A daemon with one thread whose agent made `owned`, with one finished run. */
async function withThreadAutomation() {
  const f = await fixture();
  f.daemon.createThread({
    id: "owner",
    workspaceId: "workspace",
    title: "Fix checkout",
    provider: "claude",
  });
  f.daemon.seedServices({
    settings: { "automations.enabled": true },
    threadAutomations: [{ threadId: "owner", automation: owned }],
    threadRuns: [
      {
        id: "soak-1",
        automationId: owned.id,
        title: owned.title,
        eventKey: "manual:soak-1",
        trigger: "manual",
        status: "succeeded",
        startedAt: 100,
        finishedAt: 700,
        threadId: "owner",
        result: "25 of 25 runs passed.",
      },
    ],
  });
  return f;
}

test("fake lists thread automations with their owner thread only when asked", async () => {
  const f = await withThreadAutomation();
  try {
    const plain = await f.client.request({ type: "automation.list" });
    expect(plain.automations).toEqual([]);
    expect(plain.threadAutomations).toBeUndefined();
    const listed = await f.client.request({ type: "automation.list", includeThreads: true });
    expect(listed.threadAutomations).toEqual([
      expect.objectContaining({
        automation: owned,
        threadId: "owner",
        nextRunAt: null,
        revision: 1,
        lastRun: expect.objectContaining({ id: "soak-1", result: "25 of 25 runs passed." }),
      }),
    ]);
  } finally {
    await f.client.close();
  }
});

test("fake thread automations pause, run once per request and delete through the thread source", async () => {
  const f = await withThreadAutomation();
  try {
    expect(
      await f.client.request({ type: "automation.setEnabled", id: owned.id, enabled: false }),
    ).toMatchObject({ ok: false });
    expect(
      await f.client.request({
        type: "automation.setEnabled",
        id: owned.id,
        enabled: false,
        expectedRevision: 1,
        source: "thread",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await f.client.request({
        type: "automation.setEnabled",
        id: owned.id,
        enabled: true,
        expectedRevision: 1,
        source: "thread",
      }),
    ).toMatchObject({ ok: false, error: "Automation revision conflict" });
    await f.client.request({
      type: "automation.setEnabled",
      id: owned.id,
      enabled: true,
      source: "thread",
    });
    const run = {
      type: "automation.run" as const,
      id: owned.id,
      variables: {},
      message: "Only the retry path",
      source: "thread" as const,
    };
    const first = await f.client.request(run, { requestId: "noted" });
    expect(first.run).toMatchObject({ automationId: owned.id, status: "running" });
    expect((await f.client.request(run, { requestId: "noted" })).run?.id).toBe(first.run?.id);
    const history = await f.client.request({
      type: "automation.inbox",
      automationId: owned.id,
      limit: 10,
      source: "thread",
    });
    expect(history.inbox?.runs.map((entry) => entry.id)).toEqual([first.run?.id, "soak-1"]);
    expect((await f.client.request({ type: "automation.inbox", limit: 10 })).inbox?.runs).toEqual(
      [],
    );
    await f.client.request({ type: "automation.remove", id: owned.id, source: "thread" });
    expect(
      (await f.client.request({ type: "automation.list", includeThreads: true })).threadAutomations,
    ).toEqual([]);
  } finally {
    await f.client.close();
  }
});

test("fake drops a thread automation from the list once its thread is deleted", async () => {
  const f = await withThreadAutomation();
  try {
    const deleted = await f.client.command(
      { type: "thread.delete", threadId: ThreadId.parse("owner"), force: true },
      {},
      "delete-owner",
    );
    expect(deleted).toMatchObject({ ok: true });
    expect(
      (await f.client.request({ type: "automation.list", includeThreads: true })).threadAutomations,
    ).toEqual([]);
    expect(
      await f.client.request({
        type: "automation.run",
        id: owned.id,
        variables: {},
        source: "thread",
      }),
    ).toMatchObject({ ok: false, error: "not_found" });
  } finally {
    await f.client.close();
  }
});

test("fake keeps a person automation's effort and account", async () => {
  const f = await fixture();
  try {
    const automation = { ...owned, id: "mine", instance: "claude-work" };
    await f.client.request({ type: "automation.put", automation });
    expect((await f.client.request({ type: "automation.list" })).automations).toEqual([automation]);
  } finally {
    await f.client.close();
  }
});
