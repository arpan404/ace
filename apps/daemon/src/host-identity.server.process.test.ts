import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SettingsService, fileIO } from "@ace/settings";
import { fixture } from "./socket-test-support.ts";

// Public socket results guard the identity service, settings resolution and authorization.
test("authenticated identity uses the hostname until the global display name is edited", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-host-identity-"));
  const settings = new SettingsService({
    dataDir: home,
    io: { ...fileIO, watch: async () => () => {} },
  });
  const f = await fixture({ settings, hostName: "Laptop", version: "1.2.3" });
  try {
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome", hostId: "host" });
    client.send({ type: "host.identity", requestId: "identity" });
    expect(await client.next()).toMatchObject({
      type: "host.identity.result",
      requestId: "identity",
      identity: { hostId: "host", displayName: "Laptop", version: "1.2.3" },
    });
    client.send({
      type: "settings.set",
      requestId: "rename",
      key: "host.displayName",
      value: "Office",
      layer: { kind: "global" },
    });
    expect(await client.next()).toMatchObject({
      type: "settings.result",
      requestId: "rename",
      ok: true,
    });
    client.send({ type: "host.identity", requestId: "renamed" });
    expect(await client.next()).toMatchObject({
      identity: { hostId: "host", displayName: "Office" },
    });
    await client.close();
    const again = await f.connect();
    await again.next();
    again.send({ type: "host.identity", requestId: "reconnect" });
    expect(await again.next()).toMatchObject({
      identity: { hostId: "host", displayName: "Office" },
    });
  } finally {
    await f.close();
    await settings.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an unauthenticated socket cannot read host identity", async () => {
  const f = await fixture({ hostName: "Private laptop" });
  try {
    const client = await f.open();
    client.send({ type: "host.identity", requestId: "identity" });
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  } finally {
    await f.close();
  }
});

test("identity requires read scope on an authenticated paired connection", async () => {
  const f = await fixture({ hostName: "Private laptop" });
  try {
    const issued = f.store.devices.create("Operator", ["operate"], 1000);
    const response = await fetch(`${f.server.httpUrl}/v1/tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
    });
    const { SocketTicket } = await import("@ace/protocol");
    const ticket = SocketTicket.parse(await response.json());
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: issued.device.id,
      ticket: ticket.ticket,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({ type: "host.identity", requestId: "identity" });
    expect(await client.next()).toMatchObject({
      type: "error",
      requestId: "identity",
      code: "forbidden",
    });
  } finally {
    await f.close();
  }
});
