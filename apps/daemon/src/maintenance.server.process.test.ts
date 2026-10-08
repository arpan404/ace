import { afterEach, expect, test } from "vitest";
import { Command, DiagnosticsHealth, ThreadId, type ThreadStatus } from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
test("maintenance closes websocket command admission until the local host releases it", async () => {
  const f = await fixture({ version: "1.2.3" });
  cleanups.push(() => f.close());
  const c = await f.connect();
  await c.next();
  expect(await accessRequest(f.server.httpUrl, "/v1/status", { token })).toMatchObject({
    running: true,
    version: "1.2.3",
  });
  await expect(
    accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "POST" }),
  ).rejects.toThrow("403");
  expect(
    await accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "POST", token }),
  ).toEqual({ draining: true, blockers: 0 });
  c.send({
    type: "command",
    command: Command.parse({
      id: "maintenance-test",
      deviceId: "device",
      payload: {
        type: "thread.create",
        workspaceId: f.workspace,
        provider: "codex",
        title: "blocked",
        input: [{ type: "text", text: "test" }],
      },
    }),
  });
  // The refusal names the command, so the client keeps its connection and retries later.
  expect(await c.next()).toMatchObject({
    type: "error",
    code: "maintenance",
    message: "New work is paused. Resume new work in ace to continue.",
    commandId: "maintenance-test",
    retryable: true,
  });
  expect(f.store.listThreads()).toHaveLength(1);
  await accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "DELETE", token });
  c.send({
    type: "command",
    command: Command.parse({
      id: "maintenance-released",
      deviceId: "device",
      payload: {
        type: "thread.create",
        workspaceId: f.workspace,
        provider: "codex",
        title: "allowed",
        input: [{ type: "text", text: "test" }],
      },
    }),
  });
  expect(await c.next()).toMatchObject({ type: "commandResult", ok: true });
  expect(f.store.listThreads()).toHaveLength(2);
});
test("working, approval, background and unresponsive threads block updates even when archived", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const statuses: ThreadStatus[] = [
    { state: "working", agents: 1 },
    { state: "needs_you", interactions: 1 },
    { state: "waiting", on: "background_task" },
    { state: "unresponsive" },
  ];
  for (const status of statuses) {
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status, archivedAt: 10 }]);
    expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toEqual({
      draining: false,
      blockers: 1,
    });
  }
  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toEqual({
    draining: false,
    blockers: 0,
  });
});
test("a journaled candidate starts with command admission closed", async () => {
  const f = await fixture({ maintenance: true });
  cleanups.push(() => f.close());
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toEqual({
    draining: true,
    blockers: 0,
  });
});
test("draining still accepts a human approval so existing work can settle", async () => {
  let threadId = ThreadId.parse("pending");
  const f = await fixture({
    handler: {
      handle(command, context) {
        context.appendEvents(threadId, [{ type: "thread.updated", status: { state: "done" } }]);
        return { commandId: command.id, ok: true };
      },
    },
  });
  cleanups.push(() => f.close());
  threadId = f.thread.id;
  f.store.appendEvents(threadId, [
    { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
  ]);
  const client = await f.connect();
  await client.next();
  await accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "POST", token });
  client.send({
    type: "command",
    command: Command.parse({
      id: "approve-during-drain",
      deviceId: "device",
      payload: {
        type: "interaction.resolve",
        interactionId: "approval",
        resolution: { kind: "approval", optionId: "allow" },
      },
    }),
  });
  expect(await client.next()).toMatchObject({ type: "commandResult", ok: true });
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toEqual({
    draining: true,
    blockers: 0,
  });
});

test("draining still serves read-only diagnostics without changing agent work", async () => {
  const health = DiagnosticsHealth.parse({
    at: 1,
    eventLoop: { meanMs: null, p99Ms: null, maxMs: null },
    memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
    openHandles: 0,
    sqlite: { pageBytes: 4096, walBytes: 0 },
    activeSessions: 0,
    queues: {},
    logs: { dropped: 0, failed: 0, queued: 0 },
  });
  const f = await fixture({ maintenance: true, health: async () => health });
  cleanups.push(() => f.close());
  const client = await f.connect();
  await client.next();
  const before = f.store.headSeq();
  client.send({
    type: "command",
    command: Command.parse({
      id: "health-during-drain",
      deviceId: "device",
      payload: { type: "diagnostics.health" },
    }),
  });
  expect(await client.next()).toMatchObject({
    type: "commandResult",
    ok: true,
    health: { sqlite: { pageBytes: 4096 } },
  });
  expect(f.store.headSeq()).toBe(before);
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toEqual({
    draining: true,
    blockers: 0,
  });
});
