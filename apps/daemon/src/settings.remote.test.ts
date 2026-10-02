import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { SettingsService, fileIO } from "@ace/settings";
import { ServerMessage } from "@ace/protocol";
import { ticketSocket } from "./client-access.ts";
import { cleanups, identity, setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "ace-remote-settings-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir, io: { ...fileIO, watch: async () => () => {} } });
  cleanups.push(() => settings.close());
  const f = await setup({ settings });
  return { ...f, settings };
}

test("a pinned read-only device reads and subscribes to settings but cannot write", async () => {
  const f = await fixture();
  const paired = await f.pair(["read"]);
  const issued = await f.ticket(paired.token);
  const socket = ticketSocket(f.server.remoteUrl, identity.fingerprint);
  const closed = once(socket, "close");
  cleanups.push(async () => {
    if (socket.readyState !== socket.CLOSED) socket.close();
    await closed;
  });
  await once(socket, "open");
  const ask = async (message: unknown) => {
    const reply = once(socket, "message");
    socket.send(JSON.stringify(message));
    return ServerMessage.parse(JSON.parse(String((await reply)[0])));
  };
  expect(
    await ask({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: issued.ticket,
    }),
  ).toMatchObject({ type: "welcome" });
  expect(
    await ask({ type: "settings.get", requestId: "read", key: "notifications.sound", scope: {} }),
  ).toMatchObject({ type: "settings.result", ok: true, entries: [{ value: false }] });
  expect(
    await ask({
      type: "settings.set",
      requestId: "denied",
      key: "notifications.sound",
      value: true,
      layer: { kind: "global" },
    }),
  ).toMatchObject({ type: "error", code: "forbidden" });
  expect(await f.settings.get("notifications.sound")).toMatchObject({
    value: false,
    provenance: "defaults",
  });
  expect(
    await ask({
      type: "settings.subscribe",
      requestId: "watch",
      subscriptionId: "watch",
      keys: ["notifications.sound"],
      scope: {},
    }),
  ).toMatchObject({ type: "settings.result", ok: true });
  const changed = once(socket, "message");
  await f.settings.set("notifications.sound", true, { kind: "global" });
  expect(ServerMessage.parse(JSON.parse(String((await changed)[0])))).toMatchObject({
    type: "settings.changed",
    entries: [{ value: true }],
  });
  await f.request(`/v1/devices/${paired.device.id}`, { method: "DELETE", token });
  expect((await closed)[0]).toBe(4003);
});

test("an operate-only device writes settings but cannot read or subscribe", async () => {
  const f = await fixture();
  const paired = await f.pair(["operate"]);
  const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
  await client.next();
  client.send({
    type: "settings.set",
    requestId: "write",
    key: "notifications.sound",
    value: true,
    layer: { kind: "global" },
  });
  expect(await client.next()).toMatchObject({ type: "settings.result", ok: true });
  expect(await f.settings.get("notifications.sound")).toMatchObject({
    value: true,
    provenance: "global",
  });
  client.send({ type: "settings.get", requestId: "denied", key: "notifications.sound", scope: {} });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
  client.send({
    type: "settings.subscribe",
    requestId: "deniedSub",
    subscriptionId: "denied",
    keys: ["notifications.sound"],
    scope: {},
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
});
