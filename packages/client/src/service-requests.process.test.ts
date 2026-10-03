import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { DeviceId, ClientMessage } from "@ace/protocol";
import { setup, ready, memoryStorage, when } from "./test-support.ts";
import { AccessClient, ticketCredential } from "./index.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("service reads correlate concurrent replies without storing commands or touching the outbox", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const storage = memoryStorage();
  const { client, faults } = f.make({ storage });
  await ready(client);
  const before = await storage.load();
  const [settings, models, accounts, usage, search, commands] = await Promise.all([
    client.request({ type: "settings.get", key: "threads.autoSettleAfter", scope: {} }),
    client.request({ type: "models.list" }),
    client.request({ type: "accounts.list" }),
    client.request({ type: "usage.summary", query: { from: "2026-10-01", to: "2026-10-02" } }),
    client.request({ type: "search.status" }),
    client.request({ type: "commands.list", threadId: f.thread.id }),
  ]);
  expect(settings.entries).toContainEqual({
    key: "threads.autoSettleAfter",
    value: "1d",
    provenance: "defaults",
  });
  expect(models.type).toBe("models.result");
  expect(accounts.type).toBe("accounts.list");
  expect(usage.kind).toBe("summary");
  expect(search.type).toBe("search.progress");
  expect(commands.commands.length).toBeGreaterThan(0);
  expect(await storage.load()).toBe(before);
  expect(
    f.daemon.store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n,
    ),
  ).toBe(0);
  expect(
    faults.sent
      .map((frame) => ClientMessage.parse(JSON.parse(frame)))
      .some((message) => message.type === "command"),
  ).toBe(false);
});

test("legacy health command callers receive health without creating a durable intent", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  expect(await client.command({ type: "diagnostics.health" }, {}, "health-read")).toMatchObject({
    commandId: "health-read",
    ok: true,
    health: { logs: { failed: 0 } },
  });
  expect(client.intent("health-read").getSnapshot()).toBeUndefined();
  expect(
    f.daemon.store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n,
    ),
  ).toBe(0);
});

test("an invalid request is refused before it reaches the daemon", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults } = f.make();
  await ready(client);
  const sent = faults.sent.length;
  await expect(
    client.request({ type: "search.query", text: "x".repeat(600) }),
  ).rejects.toMatchObject({ code: "protocol" });
  expect(faults.sent).toHaveLength(sent);
});

test("a request made while offline rejects instead of waiting for a connection", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await expect(client.request({ type: "models.list" })).rejects.toMatchObject({ code: "offline" });
});

test("disconnect rejects one-off requests and reconnect never replays them", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults, scheduler } = f.make();
  await ready(client);
  faults.incoming = (message, frame, deliver) => {
    if (message.type !== "settings.result") deliver(frame);
  };
  const read = client.request({ type: "settings.get", key: "providers.default", scope: {} });
  const rejected = expect(read).rejects.toMatchObject({ code: "offline" });
  await faults.wait((message) => message.type === "settings.result");
  faults.disconnect();
  await rejected;
  const count = () =>
    faults.sent.filter((frame) => ClientMessage.parse(JSON.parse(frame)).type === "settings.get")
      .length;
  expect(count()).toBe(1);
  scheduler.advance(1000);
  await when(client.connectionState(), (value) => value === "ready");
  expect(count()).toBe(1);
});

test("cancellation releases request capacity and does not cancel a different correlation", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client, faults } = f.make({ limits: { requests: 1 } });
  await ready(client);
  faults.incoming = (message, frame, deliver) => {
    if (message.type !== "settings.result") deliver(frame);
  };
  const controller = new AbortController();
  const read = client.request(
    { type: "settings.get", key: "providers.default", scope: {} },
    { signal: controller.signal },
  );
  const rejected = expect(read).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((message) => message.type === "settings.result");
  await expect(client.request({ type: "accounts.list" })).rejects.toMatchObject({ code: "limit" });
  controller.abort();
  await rejected;
  expect((await client.request({ type: "accounts.list" })).type).toBe("accounts.list");
});

test("a written setting reads back, is pushed to subscribers, and stops pushing once released", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  const changes: unknown[] = [];
  const stop = client.onMessage((message) => {
    if (message.type === "settings.changed") changes.push(message);
  });
  try {
    await client.request({
      type: "settings.subscribe",
      subscriptionId: "preferences",
      scope: {},
      keys: ["threads.autoSettleAfter"],
    });
    await client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "never",
      layer: { kind: "global" },
    });
    expect(changes).toContainEqual(
      expect.objectContaining({
        subscriptionId: "preferences",
        entries: [{ key: "threads.autoSettleAfter", value: "never", provenance: "global" }],
      }),
    );
    const read = await client.request({
      type: "settings.get",
      key: "threads.autoSettleAfter",
      scope: {},
    });
    expect(read.entries).toContainEqual({
      key: "threads.autoSettleAfter",
      value: "never",
      provenance: "global",
    });
    await client.request({ type: "settings.unsubscribe", subscriptionId: "preferences" });
    changes.length = 0;
    await client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "2d",
      layer: { kind: "global" },
    });
    expect(changes).toEqual([]);
  } finally {
    stop();
  }
});

test("a denied service write rejects that request while a read-only device stays connected", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const device = f.daemon.store.devices.create("Reader", ["read"], 1);
  const access = new AccessClient({
    origin: new URL(f.daemon.url.replace(/^ws:/, "http:")).origin,
    token: async () => device.token,
    fetch,
  });
  const { client } = f.make({
    deviceId: device.device.id,
    credential: ticketCredential(
      async () => device.token,
      () => access.ticket(),
    ),
  });
  await ready(client);
  await expect(
    client.request({
      type: "settings.set",
      key: "threads.autoSettleAfter",
      value: "never",
      layer: { kind: "global" },
    }),
  ).rejects.toMatchObject({ code: "daemon" });
  expect((await client.request({ type: "diagnostics.health" })).ok).toBe(true);
  expect(client.state).toBe("ready");
});

test("mention completion uses the authoritative workspace rather than a projected client path", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const outside = await mkdtemp(join(tmpdir(), "ace-context-outside-"));
  try {
    const project = f.daemon.store.getWorkspacePath(f.workspaceId);
    if (!project) throw new Error("Missing project");
    await promisify(execFile)("git", ["init", project]);
    await promisify(execFile)("git", ["init", outside]);
    await writeFile(join(project, "authorized-mention.txt"), "project");
    await writeFile(join(outside, "outside-secret.txt"), "private");
    f.daemon.store.appendEvents(f.thread.id, [
      { type: "thread.client.updated", changes: { details: { worktree: outside } } },
    ]);
    const { client } = f.make();
    await ready(client);
    const reply = await client.request({
      type: "context.request",
      operation: { op: "mention.complete", threadId: f.thread.id, query: "authorized-", limit: 50 },
    });
    expect(reply.result).toMatchObject({ kind: "completion", paths: ["authorized-mention.txt"] });
    const denied = await client.request({
      type: "context.request",
      operation: { op: "mention.complete", threadId: f.thread.id, query: "outside-", limit: 50 },
    });
    expect(denied.result).toMatchObject({ kind: "completion", paths: [] });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("context reads cannot fall back to the project while an isolated workspace is unprepared", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const project = f.daemon.store.getWorkspacePath(f.workspaceId);
  if (!project) throw new Error("Missing project");
  await promisify(execFile)("git", ["init", project]);
  await writeFile(join(project, "project-only.txt"), "must not resolve yet");
  f.daemon.store.appendEvents(f.thread.id, [
    {
      type: "thread.client.updated",
      changes: { details: { mode: "worktree", worktree: project } },
    },
  ]);
  const { client } = f.make();
  await ready(client);
  const reply = await client.request({
    type: "context.request",
    operation: { op: "mention.complete", threadId: f.thread.id, query: "project-", limit: 50 },
  });
  expect(reply.result).toMatchObject({ kind: "error" });
});

test("history reads with optional wire correlations work through both client APIs without durable receipts", async () => {
  const f = await setup(undefined, { instances: [] });
  cleanup = f.cleanup;
  const storage = memoryStorage();
  const { client } = f.make({ storage });
  await ready(client);
  const before = await storage.load();
  const direct = await client.request({
    type: "history.list",
    cwd: f.daemon.store.getWorkspacePath(f.workspaceId) ?? "",
    limit: 10,
  });
  const specialized = await client.listHistory({
    cwd: f.daemon.store.getWorkspacePath(f.workspaceId) ?? "",
    limit: 10,
  });
  expect(direct.sessions).toEqual(specialized.sessions);
  const status = await client.request({ type: "history.scan", action: "status" });
  expect(status.scan?.state).toBeDefined();
  expect(await storage.load()).toBe(before);
  expect(
    f.daemon.store.atomic(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n,
    ),
  ).toBe(0);
});

test("daemon draft adoption uses the same canonical project identity as mention completion", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  const draft = await client.request({
    type: "context.request",
    operation: { op: "draft.create", workspaceId: f.workspaceId },
  });
  if (draft.result.kind !== "draft") throw new Error("Expected draft");
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("canonical draft attachment");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = await client.request({
    type: "context.request",
    operation: {
      op: "draft.upload.begin",
      draftId: draft.result.draftId,
      bytes: bytes.length,
      sha256,
      name: "draft.txt",
    },
  });
  if (begin.result.kind !== "upload") throw new Error("Expected upload");
  await client.request({
    type: "context.request",
    operation: {
      op: "upload.chunk",
      uploadId: begin.result.uploadId,
      offset: 0,
      data: bytes.toString("base64"),
    },
  });
  await client.request({
    type: "context.request",
    operation: { op: "upload.commit", uploadId: begin.result.uploadId },
  });
  const prepared = await f.daemon.context.compose(
    "test-device",
    f.thread.id,
    { draftId: draft.result.draftId, mentions: [], attachments: [{ sha256 }] },
    { provider: "codex", images: [], documents: [], embeddedContext: false, maxInlineBytes: 0 },
  );
  prepared.release();
  const listed = await client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: f.thread.id },
  });
  expect(listed.result).toMatchObject({
    kind: "attachments",
    attachments: [{ sha256, name: "draft.txt", bytes: bytes.length }],
  });
});

test("listener-phase service routing reads persisted automation changes and Deck plans", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  await ready(client);
  const automation = {
    id: "integration-manual",
    title: "Saved automation",
    enabled: false,
    workspace: f.daemon.store.getWorkspacePath(f.workspaceId) ?? "",
    provider: "codex" as const,
    prompt: "Synthetic disabled task",
    worktree: false,
    trigger: { kind: "manual" as const },
    missedRun: "skip" as const,
    concurrency: 1,
    jitterMs: 0,
  };
  expect(await client.request({ type: "automation.put", automation })).toMatchObject({ ok: true });
  expect(await client.request({ type: "automation.list" })).toMatchObject({
    ok: true,
    automations: [automation],
  });
  expect(
    await client.request({ type: "conductor.request", operation: { op: "list", limit: 10 } }),
  ).toMatchObject({ ok: true, runs: [] });
  expect(await client.request({ type: "automation.remove", id: automation.id })).toMatchObject({
    ok: true,
  });
  expect(await client.request({ type: "automation.list" })).toMatchObject({
    ok: true,
    automations: [],
  });
});

test("a workspace draft lists slash commands without creating a thread and refuses another device", async () => {
  const f = await setup();
  cleanup = f.cleanup;
  const { client } = f.make();
  const { client: other } = f.make({ deviceId: DeviceId.parse("other") });
  await ready(client);
  await ready(other);
  const before = f.daemon.store.listThreads().length;
  const draft = await client.request({
    type: "context.request",
    operation: { op: "draft.create", workspaceId: f.thread.workspaceId },
  });
  if (draft.result.kind !== "draft") throw new Error("Expected draft");
  const input = {
    type: "commands.list" as const,
    draft: {
      draftId: draft.result.draftId,
      workspaceId: f.thread.workspaceId,
      provider: "codex" as const,
    },
  };
  const listed = await client.request(input);
  expect(listed.commands.length).toBeGreaterThan(0);
  const generic = await client.request({
    ...input,
    draft: { ...input.draft, provider: "acp", instanceId: "local-agent-instance" },
  });
  expect(generic.commands.length).toBeGreaterThan(0);
  expect(listed.commands.every((command) => command.scope !== "runtime")).toBe(true);
  expect(f.daemon.store.listThreads()).toHaveLength(before);
  await expect(other.request(input)).rejects.toMatchObject({ code: "daemon" });
  const otherRoot = join(f.directory, "other-draft-root");
  await mkdir(otherRoot);
  const workspaceId = f.daemon.store.createWorkspace(otherRoot, "Other");
  await expect(
    client.request({ ...input, draft: { ...input.draft, workspaceId } }),
  ).rejects.toMatchObject({ code: "daemon" });
  await client.request({
    type: "context.request",
    operation: { op: "draft.release", draftId: draft.result.draftId },
  });
  await expect(client.request(input)).rejects.toMatchObject({ code: "daemon" });
});
