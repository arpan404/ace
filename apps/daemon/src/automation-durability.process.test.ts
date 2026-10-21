import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Automation, DeviceId, ThreadId, type AutomationRequest } from "@ace/protocol";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { Client } from "./socket-test-support.ts";

async function connect(f: Awaited<ReturnType<typeof daemonFixture>>, device: string) {
  const client = new Client(f.daemon.url);
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(device),
    token: await readFile(join(f.h.home, "daemon", "daemon-token"), "utf8"),
  });
  expect((await client.next()).type).toBe("welcome");
  return {
    client,
    async ask(request: AutomationRequest) {
      client.send(request);
      for (;;) {
        const response = await client.next();
        if (response.type === "automation.result" && response.requestId === request.requestId)
          return response;
      }
    },
  };
}

const definition = (workspace: string) =>
  Automation.parse({
    id: "durable-socket-job",
    title: "Durable socket job",
    enabled: true,
    workspace,
    provider: "claude",
    prompt: "Review the project",
    worktree: false,
    trigger: { kind: "manual" },
    missedRun: "skip",
    concurrency: 1,
    jitterMs: 0,
  });

test("a stale editor cannot undo a pause committed by another connected device", async () => {
  const f = await daemonFixture();
  const editor = await connect(f, "editor");
  const operator = await connect(f, "operator");
  try {
    const automation = definition(f.workspace);
    expect(
      await editor.ask({
        type: "automation.put",
        requestId: "create",
        automation,
        expectedRevision: null,
      }),
    ).toMatchObject({ ok: true });
    const snapshot = await editor.ask({ type: "automation.list", requestId: "editor-snapshot" });
    const revision = z.number().int().positive().parse(snapshot.schedules?.[0]?.revision);
    expect(
      await operator.ask({
        type: "automation.setEnabled",
        requestId: "pause",
        id: automation.id,
        enabled: false,
        expectedRevision: revision,
      }),
    ).toMatchObject({ ok: true });
    const stale = await editor.ask({
      type: "automation.put",
      requestId: "stale-edit",
      automation: { ...automation, prompt: "An edit from an old tab" },
      expectedRevision: revision,
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/conflict/i);
    const saved = await operator.ask({ type: "automation.list", requestId: "saved" });
    expect(saved.automations).toEqual([{ ...automation, enabled: false }]);
    const pausedRevision = z.number().int().positive().parse(saved.schedules?.[0]?.revision);
    expect(pausedRevision).toBeGreaterThan(revision);
  } finally {
    await editor.client.close();
    await operator.client.close();
    await f.daemon.close();
  }
});

test("committed deletion survives reconnect and restoring its definition retains run history", async () => {
  const f = await daemonFixture();
  let connection = await connect(f, "delete-review");
  try {
    await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
    const automation = definition(f.workspace);
    expect(
      await connection.ask({
        type: "automation.put",
        requestId: "create",
        automation,
        expectedRevision: null,
      }),
    ).toMatchObject({ ok: true });
    const snapshot = await connection.ask({ type: "automation.list", requestId: "snapshot" });
    const revision = z.number().int().positive().parse(snapshot.schedules?.[0]?.revision);
    const admitted = await connection.ask({
      type: "automation.run",
      requestId: "stable-run-intent",
      id: automation.id,
      variables: {},
    });
    const runId = z.string().parse(admitted.run?.id);
    const admittedThread = () =>
      f.daemon.store
        .listThreads()
        .find((thread) => thread.title === `Automation: ${automation.title}`)?.id;
    await expect.poll(admittedThread).toBeDefined();
    const threadId = ThreadId.parse(admittedThread());
    await expect.poll(() => f.h.contexts.has(threadId)).toBe(true);
    await f.h.complete(threadId, "Reviewed");
    await f.daemon.engine?.flush();
    f.h.clock.advance(f.h.clock.now() + 1000);
    const history = () =>
      connection.ask({
        type: "automation.inbox",
        requestId: "history",
        automationId: automation.id,
        limit: 50,
      });
    await expect.poll(async () => (await history()).inbox?.runs[0]?.status).toBe("succeeded");
    const duplicate = await connection.ask({
      type: "automation.run",
      requestId: "stable-run-intent",
      id: automation.id,
      variables: {},
    });
    expect(duplicate.run?.id).toBe(runId);
    expect(
      await connection.ask({
        type: "automation.remove",
        requestId: "delete",
        id: automation.id,
        expectedRevision: revision,
      }),
    ).toMatchObject({ ok: true });
    await connection.client.close();
    connection = await connect(f, "after-reload");
    expect(await connection.ask({ type: "automation.list", requestId: "deleted" })).toMatchObject({
      ok: true,
      automations: [],
    });
    expect((await history()).inbox?.runs).toMatchObject([
      { id: runId, status: "succeeded", threadId },
    ]);
    expect(
      await connection.ask({
        type: "automation.put",
        requestId: "undo",
        automation,
        expectedRevision: null,
      }),
    ).toMatchObject({ ok: true });
    expect((await history()).inbox?.runs).toMatchObject([
      { id: runId, status: "succeeded", threadId },
    ]);
    const restored = await connection.ask({ type: "automation.list", requestId: "restored" });
    expect(z.number().parse(restored.schedules?.[0]?.revision)).toBeGreaterThan(revision);
    expect(
      await connection.ask({
        type: "automation.put",
        requestId: "stale-after-undo",
        automation: { ...automation, title: "Stale replacement" },
        expectedRevision: revision,
      }),
    ).toMatchObject({ ok: false });
  } finally {
    await connection.client.close();
    await f.daemon.close();
  }
});
