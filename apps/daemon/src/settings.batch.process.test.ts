import { afterEach, expect, test } from "vitest";
import { SettingsService, fileIO, type Scheduler } from "@ace/settings";
import type { JsonValue, SettingsKey } from "@ace/protocol";
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

const adminOnlyBatches: { name: string; entries: { key: SettingsKey; value: JsonValue }[] }[] = [
  { name: "storage retention", entries: [{ key: "storage.retentionDays", value: 30 }] },
  {
    name: "a beta feature",
    entries: [{ key: "beta.spade", value: true }],
  },
];
test.each(adminOnlyBatches)(
  "an operate-only phone's batch with $name in it is refused whole, nothing written",
  async ({ entries }) => {
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
      entries: [...role, ...entries],
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
    for (const { key } of entries) expect((await settings.get(key)).provenance).toBe("defaults");
  },
);

test("a batch naming Ask me before agents publish, from the host token alone, writes none of it", async () => {
  const f = await setup();
  // The person turned the ask on in the app.
  await f.settings.set("market.askBeforeAgentPublish", true, { kind: "global" });
  const before = await f.settings.get("providers.coder.provider");
  f.client.send({
    type: "settings.setMany",
    requestId: "guarded",
    entries: [...role, { key: "market.askBeforeAgentPublish", value: false }],
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "guarded",
    ok: false,
  });
  // The guarded key is unchanged, and so is every other key the batch named.
  expect(await f.settings.get("market.askBeforeAgentPublish")).toMatchObject({ value: true });
  expect(await f.settings.get("providers.coder.provider")).toEqual(before);
});

test("a reset from the host token alone leaves Ask me before agents publish on", async () => {
  const f = await setup();
  await f.settings.set("market.askBeforeAgentPublish", true, { kind: "global" });
  f.client.send({ type: "settings.reset", requestId: "reset" });
  expect(await f.client.next()).toMatchObject({ type: "settings.result", requestId: "reset" });
  expect(await f.settings.get("market.askBeforeAgentPublish")).toMatchObject({ value: true });
});

// Older clients (origin/main before ADR 0201) still name the media pipeline settings.
test("an older client's subscription that includes a retired media key still subscribes the rest", async () => {
  const f = await setup();
  await f.settings.set("threads.settleOnClose", true, { kind: "global" });
  f.client.send({
    type: "settings.subscribe",
    requestId: "old-web",
    subscriptionId: "web-settings",
    keys: ["threads.settleOnClose", "media.encode", "beta.spade"],
    scope: {},
  });
  const reply = await f.client.next();
  expect(reply).toMatchObject({ type: "settings.result", requestId: "old-web", ok: true });
  const keys = (reply as { entries: { key: string }[] }).entries.map((entry) => entry.key);
  expect(keys.toSorted()).toEqual(["beta.spade", "threads.settleOnClose"]);
  // The subscription is live for the keys that remain.
  await f.settings.set("threads.settleOnClose", false, { kind: "global" });
  expect(await f.client.next()).toMatchObject({
    type: "settings.changed",
    subscriptionId: "web-settings",
    entries: [expect.objectContaining({ key: "threads.settleOnClose", value: false })],
  });
});

test("an older phone reading a retired media key gets a successful answer with nothing in it", async () => {
  const f = await setup();
  for (const key of ["media.encode", "media.delivery"] as const) {
    f.client.send({ type: "settings.get", requestId: `get-${key}`, key, scope: {} });
    expect(await f.client.next()).toEqual({
      type: "settings.result",
      requestId: `get-${key}`,
      ok: true,
      entries: [],
      diagnostics: [],
    });
  }
});

test("an older client's batch with a retired media key saves the rest and ignores that key", async () => {
  const f = await setup();
  f.client.send({
    type: "settings.setMany",
    requestId: "old-beta",
    entries: [
      { key: "media.delivery", value: "auto" },
      { key: "beta.spade", value: true },
    ],
    layer: { kind: "global" },
  });
  const reply = await f.client.next();
  expect(reply).toMatchObject({ type: "settings.result", requestId: "old-beta", ok: true });
  expect((reply as { entries: { key: string }[] }).entries.map((entry) => entry.key)).toEqual([
    "beta.spade",
  ]);
  expect(await f.settings.get("beta.spade")).toMatchObject({ value: true, provenance: "global" });
  // Alone, a retired key is a write that changes nothing and succeeds.
  f.client.send({
    type: "settings.set",
    requestId: "old-switch",
    key: "media.encode",
    value: "legacy",
    layer: { kind: "global" },
  });
  expect(await f.client.next()).toMatchObject({
    type: "settings.result",
    requestId: "old-switch",
    ok: true,
    entries: [],
  });
});
