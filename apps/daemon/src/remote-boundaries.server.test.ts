import { once } from "node:events";
import { expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import { redeemPairing } from "./client-access.ts";
import { cleanups, setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

it("rate limits malformed pairing bodies as well as wrong codes", async () => {
  const f = await setup();
  for (let attempt = 0; attempt < 5; attempt++)
    await expect(
      f.remoteRequest("/v1/pair", { method: "POST", body: { name: "Phone" } }),
    ).rejects.toThrow("HTTP 400");
  await expect(f.remoteRequest("/v1/pair", { method: "POST", body: {} })).rejects.toThrow(
    "HTTP 429",
  );
});
it("allows explicitly granted admins to manage devices and create pairings without changing the requested scopes", async () => {
  const f = await setup();
  const admin = await f.pair(["admin"]);
  expect(await f.remoteRequest("/v1/devices", { token: admin.token })).toMatchObject([
    { id: admin.device.id, scopes: ["admin"] },
  ]);
  const pairing = await f.remoteRequest("/v1/pairings", {
    method: "POST",
    token: admin.token,
    body: { scopes: ["read"] },
  });
  if (
    !pairing ||
    typeof pairing !== "object" ||
    !("url" in pairing) ||
    typeof pairing.url !== "string"
  )
    throw new Error("Missing pairing URL");
  const device = await redeemPairing(pairing.url, "Read phone");
  expect(device.device.scopes).toEqual(["read"]);
  expect(
    await f.remoteRequest(`/v1/devices/${device.device.id}`, {
      method: "DELETE",
      token: admin.token,
    }),
  ).toEqual({ revoked: true });
});
it("rejects fabricated tokens and scope injection by a redeeming device", async () => {
  const f = await setup();
  await expect(f.ticket("b".repeat(64))).rejects.toThrow("HTTP 401");
  const pairing = await f.pairing(["read"]);
  const fragment = new URLSearchParams(new URL(pairing.url).hash.slice(1));
  const result = await f.remoteRequest("/v1/pair", {
    method: "POST",
    body: { code: fragment.get("code"), name: "Phone", scopes: ["admin"] },
  });
  expect(result).toMatchObject({ device: { scopes: ["read"] } });
  await expect(
    f.request("/v1/pairings", { method: "POST", token, body: { scopes: ["root"] } }),
  ).rejects.toThrow("HTTP 400");
});
it("updates last seen through device authentication and never revokes the host credential sharing a caller-selected id", async () => {
  const f = await setup();
  const paired = await f.pair();
  const host = await f.open();
  host.send({ type: "hello", protocolVersion: 1, deviceId: paired.device.id, token });
  await host.next();
  f.advance(1000);
  await f.ticket(paired.token);
  expect(await f.request("/v1/devices", { token })).toMatchObject([{ lastSeenAt: 2000 }]);
  const closed = once(host.socket, "close");
  cleanups.push(async () => {
    await host.close();
    await closed;
  });
  await f.request(`/v1/devices/${paired.device.id}`, { method: "DELETE", token });
  host.send({ type: "ping" });
  expect(await host.next()).toEqual({ type: "pong" });
});
it("rejects hello containing two credentials even when one is valid", async () => {
  const f = await setup();
  const paired = await f.pair();
  const client = await f.open();
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse(paired.device.id),
    token,
    ticket: (await f.ticket(paired.token)).ticket,
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
});
