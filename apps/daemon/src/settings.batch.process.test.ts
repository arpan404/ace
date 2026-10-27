import { afterEach, expect, test } from "vitest";
import { SettingsService, fileIO, type Scheduler } from "@ace/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./socket-test-support.ts";
import { setup as remote } from "./remote-test-support.ts";

/*
 * `settings.setMany` over a real daemon socket: a role change (model, provider, effort) is
 * written all or none, so a phone or the web never leaves a role half-set.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  const scheduler: Scheduler = { schedule: () => () => {} };
  const settings = new SettingsService({
    dataDir: f.home,
    io: { ...fileIO, watch: async () => () => {} },
    scheduler,
  });
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
  return { client, settings };
}
const role = [
  { key: "providers.coder.model", value: "claude-opus-5-5" },
  { key: "providers.coder.provider", value: "claude" },
  { key: "providers.coder.reasoningEffort", value: "high" },
];

test("a role change is saved in one request and answered with every key it set", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.setMany",
    requestId: "role",
    entries: role,
    layer: { kind: "global" },
  });
  const reply = await f.client.next();
  expect(reply).toMatchObject({ type: "settings.result", requestId: "role", ok: true });
  expect(await f.settings.get("providers.coder.provider")).toMatchObject({
    value: "claude",
    provenance: "global",
  });
  expect(await f.settings.get("providers.coder.reasoningEffort")).toMatchObject({ value: "high" });
});

test("a role change with one value the daemon refuses writes none of it", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.setMany",
    requestId: "bad",
    entries: [...role.slice(0, 2), { key: "providers.coder.reasoningEffort", value: "enormous" }],
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "bad",
    ok: false,
  });
  expect((await f.settings.get("providers.coder.model")).provenance).toBe("defaults");
  expect((await f.settings.get("providers.coder.provider")).provenance).toBe("defaults");
});

test("a batch that includes a setting the daemon handles on its own is refused whole", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.setMany",
    requestId: "mixed",
    entries: [
      { key: "providers.coder.provider", value: "claude" },
      { key: "remote.enabled", value: true },
    ],
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    ok: false,
    diagnostics: [{ message: "Set remote.enabled on its own, not with others" }],
  });
  expect((await f.settings.get("providers.coder.provider")).provenance).toBe("defaults");
});

test("an operate-only phone's batch with one admin-only setting is refused whole, nothing written", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-batch-"));
  const settings = new SettingsService({
    dataDir: home,
    io: { ...fileIO, watch: async () => () => {} },
    scheduler: { schedule: () => () => {} },
  });
  cleanups.push(async () => {
    await settings.close();
    await rm(home, { recursive: true, force: true });
  });
  const f = await remote({ settings });
  const device = await f.pair(["read", "operate"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({
    type: "settings.setMany",
    requestId: "admin",
    entries: [...role, { key: "storage.retentionDays", value: 30 }],
    layer: { kind: "global" },
  });
  for (;;) {
    const reply = await phone.next();
    if ("requestId" in reply && reply.requestId === "admin") {
      expect(reply).not.toMatchObject({ ok: true });
      break;
    }
  }
  expect((await settings.get("providers.coder.model")).provenance).toBe("defaults");
  expect((await settings.get("providers.coder.provider")).provenance).toBe("defaults");
  expect((await settings.get("storage.retentionDays")).provenance).toBe("defaults");
});
