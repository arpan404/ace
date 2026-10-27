import { afterEach, expect, test } from "vitest";
import { SettingsService, fileIO, type Scheduler } from "@ace/settings";
import { fixture } from "./socket-test-support.ts";

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
