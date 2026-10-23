import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "@ace/settings";
import {
  FleetResult,
  PairingResponse,
  type FleetOperation,
  type ServerMessage,
} from "@ace/protocol";
import { redeemPairing } from "./client-access.ts";
import { setup } from "./remote-test-support.ts";
import { token, type Client } from "./socket-test-support.ts";

const day = 24 * 60 * 60_000;
let requests = 0;

/** One `fleet.request` and its reply (a result or a refusal), skipping unrelated pushes. */
async function ask(client: Client, operation: FleetOperation) {
  const requestId = `fleet-${++requests}`;
  client.send({ type: "fleet.request", requestId, operation });
  for (;;) {
    const message: ServerMessage = await client.next();
    if (message.type === "fleet.result" && message.requestId === requestId)
      return { result: FleetResult.shape.result.parse(message.result), error: undefined };
    if (message.type === "error" && message.requestId === requestId)
      return { result: undefined, error: { code: message.code, message: message.message } };
  }
}
async function welcomed(client: Client) {
  expect(await client.next()).toMatchObject({ type: "welcome" });
  return client;
}
async function issue(client: Client, operation: Extract<FleetOperation, { op: "pairing" }>) {
  const { result } = await ask(client, operation);
  if (result?.kind !== "pairing") throw new Error("No pairing issued");
  return result;
}
/** A device paired from a fresh link, connected over the socket with a ticket. */
async function pairedSocket(f: Awaited<ReturnType<typeof setup>>, scopes: string[]) {
  const credential = await f.pair(scopes);
  const ticket = await f.ticket(credential.token);
  const client = await welcomed(await f.connectTicket(credential.device.id, ticket.ticket));
  return { credential, client };
}

it("a pairing link's label names the device that redeems it, and the link works once", async () => {
  const f = await setup();
  const host = await welcomed(await f.connect());
  const pairing = await issue(host, { op: "pairing", scopes: ["read"], label: "Kitchen iPad" });
  expect(new URL(pairing.url).hash).toContain(`code=${pairing.code}`);
  const credential = await redeemPairing(pairing.url, "iPad");
  expect(credential.device).toMatchObject({ name: "Kitchen iPad", scopes: ["read"] });
  await expect(redeemPairing(pairing.url, "iPad")).rejects.toThrow("HTTP 401");
});

it("Pair a device opens app.acehq.dev once pairing links are set to, and the link still pairs", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-fleet-hosted-"));
  const settings = new SettingsService({ dataDir: home });
  onTestFinished(async () => {
    await settings.close();
    await rm(home, { recursive: true, force: true });
  });
  const f = await setup({ settings });
  const host = await welcomed(await f.connect());
  const own = await issue(host, { op: "pairing", scopes: ["read"] });
  expect(new URL(own.url).origin).toBe(
    new URL(f.server.remoteUrl.replace("wss:", "https:")).origin,
  );

  await settings.set("remote.hostedPairingLink", true, { kind: "global" });
  const hosted = await issue(host, { op: "pairing", scopes: ["read"] });
  expect(new URL(hosted.url).origin).toBe("https://app.acehq.dev");
  expect((await redeemPairing(hosted.url, "iPhone")).device.name).toBe("iPhone");
});

it("a pairing link stops working once its lifetime passes", async () => {
  const f = await setup();
  const host = await welcomed(await f.connect());
  const hour = await issue(host, { op: "pairing", scopes: ["read"], ttlMs: 60 * 60_000 });
  const short = await issue(host, { op: "pairing", scopes: ["read"] });
  f.advance(10 * 60_000);
  // The five-minute default is gone; the hour-long link still pairs.
  await expect(redeemPairing(short.url, "Phone")).rejects.toThrow("HTTP 401");
  expect((await redeemPairing(hour.url, "Phone")).device.name).toBe("Phone");
  // Only the offered lifetimes are accepted.
  await expect(
    f.request("/v1/pairings", { method: "POST", token, body: { scopes: ["read"], ttlMs: 123 } }),
  ).rejects.toThrow("HTTP 400");
});

it("a device paired for a day loses access after it and is listed as expired, not revoked", async () => {
  const f = await setup();
  const host = await welcomed(await f.connect());
  const pairing = await issue(host, { op: "pairing", scopes: ["read"], deviceTtlMs: day });
  const credential = await redeemPairing(pairing.url, "Laptop");
  const ticket = await f.ticket(credential.token);
  const device = await welcomed(await f.connectTicket(credential.device.id, ticket.ticket));
  device.send({ type: "host.identity", requestId: "before" });
  expect(await device.next()).toMatchObject({ type: "host.identity.result" });

  f.advance(day + 1);
  device.send({ type: "host.identity", requestId: "after" });
  expect(await device.next()).toMatchObject({ type: "error", requestId: "after" });
  await expect(f.ticket(credential.token)).rejects.toThrow("HTTP 401");
  const { result } = await ask(host, { op: "devices" });
  expect(result).toMatchObject({
    kind: "devices",
    devices: [{ id: credential.device.id, revokedAt: null, expiresAt: 1000 + day }],
  });
});

it("a device can't grant Projects or Accounts it doesn't hold, while the host grants both", async () => {
  const f = await setup();
  const { client: admin } = await pairedSocket(f, ["admin"]);
  for (const [scope, name] of [
    ["accounts", "Accounts"],
    ["projects", "Projects"],
  ] as const)
    expect(await ask(admin, { op: "pairing", scopes: ["read", scope] })).toEqual({
      result: undefined,
      error: {
        code: "forbidden",
        message: `You can't grant ${name}: this device doesn't have it.`,
      },
    });
  // The same ceiling holds on the HTTP route.
  const adminToken = (await f.pair(["admin"])).token;
  await expect(
    f.remoteRequest("/v1/pairings", {
      method: "POST",
      token: adminToken,
      body: { scopes: ["accounts"] },
    }),
  ).rejects.toThrow("You can't grant Accounts");
  expect((await issue(admin, { op: "pairing", scopes: ["read", "admin"] })).url).toContain("#");
  const host = await welcomed(await f.connect());
  const pairing = await issue(host, { op: "pairing", scopes: ["projects", "accounts"] });
  expect((await redeemPairing(pairing.url, "Desk")).device.scopes).toEqual([
    "projects",
    "accounts",
  ]);
});

it("open pairing links are listed without their codes, and a cancelled one no longer pairs", async () => {
  const f = await setup();
  const host = await welcomed(await f.connect());
  const kept = await issue(host, { op: "pairing", scopes: ["read"], label: "Phone" });
  // Distinct expiry times keep listing order independent of random pairing IDs.
  f.advance(1);
  const cancelled = await issue(host, {
    op: "pairing",
    scopes: ["read", "operate"],
    deviceTtlMs: 7 * day,
  });
  const listed = await ask(host, { op: "pairings" });
  expect(listed.result).toEqual({
    kind: "pairings",
    pairings: [
      { id: kept.id, label: "Phone", scopes: ["read"], expiresAt: kept.expiresAt },
      {
        id: cancelled.id,
        scopes: ["read", "operate"],
        expiresAt: cancelled.expiresAt,
        deviceTtlMs: 7 * day,
      },
    ],
  });
  const text = JSON.stringify(listed);
  expect(text).not.toContain(kept.code);
  expect(text).not.toContain(cancelled.code);

  expect(await ask(host, { op: "cancelPairing", id: cancelled.id })).toMatchObject({
    result: { kind: "pairingCancelled" },
  });
  await expect(redeemPairing(cancelled.url, "Phone")).rejects.toThrow("HTTP 401");
  expect(await ask(host, { op: "cancelPairing", id: cancelled.id })).toMatchObject({
    error: { code: "not_found" },
  });
  expect((await ask(host, { op: "pairings" })).result).toMatchObject({
    pairings: [{ id: kept.id }],
  });
  // The HTTP route's pairings are the same pending links.
  const http = PairingResponse.parse(
    await f.request("/v1/pairings", { method: "POST", token, body: { scopes: ["read"] } }),
  );
  expect((await ask(host, { op: "pairings" })).result).toMatchObject({
    pairings: [{ id: kept.id }, { id: http.id }],
  });
});

it("revoking every other device spares the caller's own, which the device list marks", async () => {
  const f = await setup();
  const phone = await f.pair(["read"]);
  const tablet = await f.pair(["read", "operate"]);
  const { credential, client: admin } = await pairedSocket(f, ["admin"]);
  expect((await ask(admin, { op: "devices" })).result).toMatchObject({
    kind: "devices",
    selfId: credential.device.id,
  });
  expect(await ask(admin, { op: "revokeOthers" })).toMatchObject({
    result: { kind: "revoked", count: 2 },
  });
  const { result } = await ask(admin, { op: "devices" });
  if (result?.kind !== "devices") throw new Error("No device list");
  const revoked = new Map(result.devices.map((device) => [device.id, device.revokedAt !== null]));
  expect(Object.fromEntries(revoked)).toEqual({
    [phone.device.id]: true,
    [tablet.device.id]: true,
    [credential.device.id]: false,
  });
  await expect(f.ticket(phone.token)).rejects.toThrow("HTTP 401");
});

it("a device without administrator access can't use fleet requests", async () => {
  const f = await setup();
  const { client } = await pairedSocket(f, ["read", "operate"]);
  for (const operation of [
    { op: "devices" },
    { op: "pairing", scopes: ["read"] },
    { op: "links" },
  ] satisfies FleetOperation[])
    expect(await ask(client, operation)).toMatchObject({ error: { code: "forbidden" } });
});
