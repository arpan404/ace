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
async function setup(
  pressure: NonNullable<import("./server-options.ts").ServerOptions["pressure"]> = {},
) {
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
  const { Projects } = await import("./projects.ts");
  const projects = new Projects(f.store, () => 1000, {
    home: f.home,
    roots: async () => (await settings.get("projects.roots")).value,
  });
  const server = await startServer({
    settings,
    projects,
    pressure,
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
    await projects.close();
    await settings.close();
    await f.close();
  });
  return { ...f, client, settings };
}

test("saved folder access takes effect immediately and invalid roots preserve the working allowlist", async () => {
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const f = await setup();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "ace-extra-projects-")));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  const browse = async () => {
    f.client.send({
      type: "projects.request",
      requestId: "browse",
      operation: { op: "fs.browse", path: outside, limit: 100, showHidden: false },
    });
    return f.client.next();
  };
  expect(await browse()).toMatchObject({
    result: { kind: "error", code: "outside_project_roots" },
  });
  f.client.send({
    type: "settings.set",
    requestId: "allow",
    key: "projects.roots",
    value: [f.home, outside],
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: [await realpath(f.home), outside] }],
  });
  expect(await browse()).toMatchObject({ result: { kind: "directories" } });
  for (const root of ["relative", join(outside, "missing"), "/etc"]) {
    f.client.send({
      type: "settings.set",
      requestId: "invalid-root",
      key: "projects.roots",
      value: [root],
      layer: { kind: "global" },
    });
    expect(await f.client.next()).toMatchObject({
      ok: false,
      diagnostics: [{ code: "validation" }],
    });
    expect(await browse()).toMatchObject({ result: { kind: "directories" } });
  }
  f.client.send({
    type: "settings.set",
    requestId: "remove",
    key: "projects.roots",
    value: [],
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({ ok: true });
  expect(await browse()).toMatchObject({
    result: { kind: "error", code: "outside_project_roots" },
  });
});

test("authenticated settings requests assign, resolve and stream only selected changes", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.subscribe",
    requestId: "sub",
    subscriptionId: "prefs",
    keys: ["threads.settleOnClose"],
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
    key: "threads.settleOnClose",
    value: true,
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.changed",
    subscriptionId: "prefs",
    entries: [{ key: "threads.settleOnClose", value: true, provenance: "global" }],
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
    key: "threads.settleOnClose",
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
    key: "clients.theme",
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
    key: "threads.settleOnClose",
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
    key: "threads.unresponsiveAfter",
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
    key: "threads.unresponsiveAfter",
    value: "2m",
    layer: { kind: "workspace", workspaceId },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: "2m", provenance: "workspace" }],
  });
  f.client.send({
    type: "settings.get",
    requestId: "thread",
    key: "threads.unresponsiveAfter",
    scope: { threadId: thread.id },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: "2m", provenance: "workspace" }],
  });
  f.client.send({
    type: "settings.set",
    requestId: "override",
    key: "threads.unresponsiveAfter",
    value: "15m",
    layer: { kind: "thread", threadId: thread.id },
  });
  expect(await f.client.next()).toMatchObject({
    ok: true,
    entries: [{ value: "15m", provenance: "thread" }],
  });
  f.client.send({
    type: "settings.get",
    requestId: "mismatch",
    key: "threads.unresponsiveAfter",
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
    keys: ["threads.settleOnClose"],
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
  f.client.send({
    type: "settings.get",
    requestId: "read",
    key: "threads.settleOnClose",
    scope: {},
  });
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
  client.send({
    type: "settings.get",
    requestId: "unauth",
    key: "threads.settleOnClose",
    scope: {},
  });
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
  await daemon.settings.set("threads.settleOnClose", true, { kind: "global" });
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("device"),
    token: (await readFile(daemon.tokenPath, "utf8")).trim(),
  });
  await client.next();
  client.send({
    type: "settings.get",
    requestId: "daemon",
    key: "threads.settleOnClose",
    scope: {},
  });
  expect(await client.next()).toMatchObject({
    type: "settings.result",
    ok: true,
    entries: [{ value: true, provenance: "global" }],
  });
  await client.close();
  await daemon.close();
  await expect(daemon.settings.get("threads.settleOnClose")).rejects.toThrow("closed");
});

test("settings deliveries exceeding the socket byte cap request a reconnect", async () => {
  const { once } = await import("node:events");
  const f = await setup({ maxQueuedBytes: 128 });
  const client = f.client;
  const closed = once(client.socket, "close");
  client.send({
    type: "settings.get",
    requestId: "oversized",
    key: "threads.settleOnClose",
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

test("a local reset clears every preference in one commit while keeping the project folders", async () => {
  const f = await setup();
  const layer = { kind: "global" } as const;
  await f.settings.set("providers.default", "claude", layer);
  await f.settings.set("permissions.providerModes", { codex: "never" }, layer);
  await f.settings.set("providers.configuration", [], layer);
  await f.settings.set("host.displayName", "Renamed", layer);
  await f.settings.set("threads.useWorktree", false, layer);
  await f.settings.set("projects.roots", [f.home], layer);
  f.client.send({
    type: "settings.subscribe",
    requestId: "watch-reset",
    subscriptionId: "reset-watch",
    keys: [
      "providers.default",
      "permissions.providerModes",
      "host.displayName",
      "threads.useWorktree",
    ],
    scope: {},
  });
  await f.client.next();
  f.client.send({ type: "settings.reset", requestId: "reset" });
  expect(await f.client.next()).toMatchObject({
    type: "settings.changed",
    entries: [
      { key: "host.displayName", provenance: "defaults" },
      { key: "providers.default", provenance: "defaults" },
      { key: "permissions.providerModes", provenance: "defaults" },
      { key: "threads.useWorktree", provenance: "defaults" },
    ],
  });
  expect((await f.settings.get("projects.roots")).value).toEqual([f.home]);
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "reset",
    ok: true,
  });
  for (const key of [
    "providers.default",
    "permissions.providerModes",
    "providers.configuration",
    "host.displayName",
    "threads.useWorktree",
  ] as const)
    expect((await f.settings.get(key)).provenance).toBe("defaults");
});
