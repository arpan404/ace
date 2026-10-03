import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { SettingsService, fileIO, type Scheduler } from "@ace/settings";
import { WorkspaceId } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  const timers = new Set<() => void>();
  const scheduler: Scheduler = {
    schedule(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  };
  const settings = new SettingsService({
    dataDir: f.home,
    io: { ...fileIO, watch: async () => () => {} },
    scheduler,
  });
  // Create a separate real listener with the settings dependency installed.
  const { startServer } = await import("./server.ts");
  const { stubHandler } = await import("./commands.ts");
  const { token, Client } = await import("./socket-test-support.ts");
  const { once } = await import("node:events");
  const { DeviceId } = await import("@ace/protocol");
  const server = await startServer({
    settings,
    store: f.store,
    handler: stubHandler(),
    token,
    hostId: "host",
    port: 0,
  });
  const client = new Client(server.url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("device"), token });
  await client.next();
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await settings.close();
    await f.close();
  });
  return { ...f, client, settings };
}

test("authenticated settings requests assign, resolve and stream only selected changes", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.subscribe",
    requestId: "sub",
    subscriptionId: "prefs",
    keys: ["notifications.sound"],
    scope: {},
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "sub",
    ok: true,
    entries: [{ value: false, provenance: "defaults" }],
  });
  f.client.send({
    type: "settings.set",
    requestId: "other",
    key: "remote.enabled",
    value: true,
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "other",
    ok: true,
  });
  f.client.send({
    type: "settings.set",
    requestId: "sound",
    key: "notifications.sound",
    value: true,
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.changed",
    subscriptionId: "prefs",
    entries: [{ key: "notifications.sound", value: true, provenance: "global" }],
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "sound",
    ok: true,
  });
  f.client.send({ type: "unsubscribe", subscriptionId: "prefs" });
  f.client.send({
    type: "settings.set",
    requestId: "after",
    key: "notifications.sound",
    value: false,
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "after",
    ok: true,
  });
});

test("wire settings reject secret values and unknown scopes with typed diagnostics", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.set",
    requestId: "secret",
    key: "plugins.preferences",
    value: { apiToken: "sensitive" },
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "secret",
    ok: false,
    diagnostics: [{ code: "secret" }],
  });
  f.client.send({
    type: "settings.set",
    requestId: "forbidden",
    key: "providers.apiToken",
    value: "sensitive",
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "forbidden",
    ok: false,
    diagnostics: [{ code: "secret" }],
  });
  f.client.send({
    type: "settings.get",
    requestId: "scope",
    key: "notifications.sound",
    scope: { workspaceId: WorkspaceId.parse("unknown") },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "scope",
    ok: false,
    diagnostics: [{ code: "validation" }],
  });
  f.client.send({
    type: "settings.set",
    requestId: "invalid",
    key: "conductor.maxFixRounds",
    value: -1,
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "invalid",
    ok: false,
    diagnostics: [{ code: "validation" }],
  });
});

test("thread wire scopes inherit their daemon-owned workspace and reject mismatches", async () => {
  const f = await setup();
  const repo = join(f.home, "repo");
  await mkdir(repo);
  const workspaceId = f.store.createWorkspace(repo, "Settings repo");
  const { createDevThread } = await import("./commands.ts");
  const thread = createDevThread(f.store, workspaceId);
  f.client.send({
    type: "settings.set",
    requestId: "workspace",
    key: "conductor.maxFixRounds",
    value: 8,
    layer: { kind: "workspace", workspaceId },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: 8, provenance: "workspace" }],
  });
  f.client.send({
    type: "settings.get",
    requestId: "thread",
    key: "conductor.maxFixRounds",
    scope: { threadId: thread.id },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: 8, provenance: "workspace" }],
  });
  f.client.send({
    type: "settings.set",
    requestId: "override",
    key: "conductor.maxFixRounds",
    value: 9,
    layer: { kind: "thread", threadId: thread.id },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: 9, provenance: "thread" }],
  });
  f.client.send({
    type: "settings.get",
    requestId: "mismatch",
    key: "conductor.maxFixRounds",
    scope: { threadId: thread.id, workspaceId: f.workspace },
  });
  expect(await f.client.next()).toMatchObject({ ok: false, diagnostics: [{ code: "validation" }] });
});

test("invalid edits reach subscribed sockets as diagnostics while reads retain the last good value", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.subscribe",
    requestId: "watch",
    subscriptionId: "watch",
    keys: ["notifications.sound"],
    scope: {},
  });
  await f.client.next();
  await writeFile(join(f.home, "settings.json"), "invalid");
  await f.settings.refresh({ kind: "global" });
  expect(await f.client.next()).toMatchObject({
    type: "settings.diagnostic",
    subscriptionId: "watch",
    diagnostic: { code: "parse" },
  });
  f.client.send({ type: "settings.get", requestId: "read", key: "notifications.sound", scope: {} });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    ok: true,
    entries: [{ value: false }],
    diagnostics: [{ code: "parse" }],
  });
});

test("settings requests require the existing authenticated hello", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const client = await f.open();
  client.send({ type: "settings.get", requestId: "unauth", key: "notifications.sound", scope: {} });
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
});

test("daemon startup exposes the same settings service used by its sockets and closes it on shutdown", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { once } = await import("node:events");
  const { DeviceId } = await import("@ace/protocol");
  const { startDaemon } = await import("./index.ts");
  const { Client } = await import("./socket-test-support.ts");
  const dataDir = await mkdtemp(join(tmpdir(), "ace-settings-daemon-"));
  const daemon = await startDaemon({
    config: {
      dataDir,
      host: "127.0.0.1",
      port: 0,
      listen: "local",
      remotePort: 0,
      logLevel: "silent",
    },
  });
  const client = new Client(daemon.url);
  cleanups.push(async () => {
    await client.close();
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await once(client.socket, "open");
  await daemon.settings.set("notifications.sound", true, { kind: "global" });
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("device"),
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  });
  await client.next();
  client.send({ type: "settings.get", requestId: "daemon", key: "notifications.sound", scope: {} });
  expect(await client.next()).toMatchObject({
    type: "settings.result",
    ok: true,
    entries: [{ value: true, provenance: "global" }],
  });
  await client.close();
  await daemon.close();
  await expect(daemon.settings.get("notifications.sound")).rejects.toThrow("closed");
});

test("settings deliveries exceeding the socket byte cap request a reconnect", async () => {
  const { once } = await import("node:events");
  const f = await fixture({ pressure: { hardLimit: 64 } });
  cleanups.push(() => f.close());
  const client = await f.connect();
  await client.next();
  const closed = once(client.socket, "close");
  client.send({
    type: "settings.get",
    requestId: "oversized",
    key: "notifications.sound",
    scope: {},
  });
  const first = await Promise.race([
    closed.then((args) => args[0]),
    client.next().then(
      (message) => message.type,
      () => closed.then((args) => args[0]),
    ),
  ]);
  expect(first).toBe(4009);
});
