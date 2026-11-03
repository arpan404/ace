import { afterEach, expect, it } from "vitest";
import { connectClientViaRelay, startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { parsePairingLink } from "@ace/client/access";
import {
  type DeviceScope,
  type FleetOperation,
  type ServerMessage,
  type RemoteAccessStatus,
} from "@ace/protocol";
import { fixture, token } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";

/*
 * Settings' remote access status, paired devices, pairing and revoking for a machine this window
 * reaches only through a self-hosted relay: `fleet.request` answers what the HTTP routes answer,
 * with the same admin rule.
 */

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function relayedDaemon() {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const f = await fixture({ relay: { url: relay.url, keys: keyPair() } });
  cleanup.push(() => f.close());
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  /** A main channel through the relay, signed in as a device with `scopes`. */
  async function signIn(scopes: DeviceScope[]) {
    const paired = f.store.devices.create("Phone", scopes, Date.now());
    const channel = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: hostId as string,
      pinnedFingerprint: hostId as string,
    });
    cleanup.push(() => channel.close());
    const seen: ServerMessage[] = [];
    const next = async (accept: (incoming: ServerMessage) => boolean) => {
      const earlier = seen.findIndex(accept);
      if (earlier >= 0) return seen.splice(earlier, 1)[0] as ServerMessage;
      while (true) {
        const incoming = await channel.receive();
        if (accept(incoming)) return incoming;
        seen.push(incoming);
      }
    };
    await channel.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      token: paired.token,
    });
    await next((incoming) => incoming.type === "welcome");
    let asked = 0;
    /** One `fleet.request`: its result, or the refusal's code. */
    const fleet = async (operation: FleetOperation) => {
      const requestId = `fleet-${++asked}`;
      await channel.send({ type: "fleet.request", requestId, operation });
      const reply = await next(
        (incoming) =>
          (incoming.type === "fleet.result" || incoming.type === "error") &&
          incoming.requestId === requestId,
      );
      if (reply.type === "fleet.result") return reply.result;
      if (reply.type === "error") return { refused: reply.code };
      throw new Error(`Unexpected ${reply.type}`);
    };
    return { device: paired.device, token: paired.token, fleet };
  }
  return { f, hostId, signIn };
}

const httpStatus = async (origin: string, bearer: string) =>
  (
    (await accessRequest(origin, "/v1/status", { token: bearer })) as {
      remoteAccess: RemoteAccessStatus;
    }
  ).remoteAccess;

it("an administrator through the relay reads the same remote access status as the HTTP route", async () => {
  const { f, hostId, signIn } = await relayedDaemon();
  const admin = await signIn(["read", "operate", "admin"]);

  const result = await admin.fleet({ op: "remoteStatus" });

  expect(result).toEqual({
    kind: "remoteStatus",
    status: await httpStatus(f.server.httpUrl, token),
  });
  expect(result).toMatchObject({ status: { transport: "relay", relay: { fingerprint: hostId } } });
});

it("a device without admin is refused status, devices, pairing and revoking, through the relay as over HTTP", async () => {
  const { f, signIn } = await relayedDaemon();
  const reader = await signIn(["read", "operate"]);
  const other = f.store.devices.create("Tablet", ["read"], Date.now());

  for (const operation of [
    { op: "remoteStatus" },
    { op: "devices" },
    { op: "pairing", scopes: ["read"] },
    { op: "revoke", deviceId: other.device.id },
  ] satisfies FleetOperation[])
    expect(await reader.fleet(operation)).toEqual({ refused: "forbidden" });
  await expect(httpStatus(f.server.httpUrl, reader.token)).rejects.toThrow();
  expect(f.store.devices.get(other.device.id)?.revokedAt).toBeNull();
});

it("an administrator through the relay lists, pairs and revokes devices as the HTTP routes do", async () => {
  const { f, hostId, signIn } = await relayedDaemon();
  const admin = await signIn(["read", "operate", "admin"]);
  const tablet = f.store.devices.create("Tablet", ["read"], Date.now());

  const listed = await admin.fleet({ op: "devices" });
  expect(listed).toMatchObject({ kind: "devices", selfId: admin.device.id });
  expect(listed).toMatchObject({
    devices: await accessRequest(f.server.httpUrl, "/v1/devices", { token }),
  });

  const issued = await admin.fleet({ op: "pairing", scopes: ["read"] });
  if ("refused" in issued || issued.kind !== "pairing") throw new Error("No pairing link");
  expect(parsePairingLink(issued.url).relay?.hostId).toBe(hostId);

  expect(await admin.fleet({ op: "revoke", deviceId: tablet.device.id })).toEqual({
    kind: "revoked",
  });
  expect(f.store.devices.get(tablet.device.id)?.revokedAt).not.toBeNull();
});

it("an administrator through the relay can't grant a scope it doesn't hold, as over HTTP", async () => {
  const { f, signIn } = await relayedDaemon();
  // Admin implies every scope but projects and accounts, which only the desktop app holds.
  const admin = await signIn(["read", "admin"]);

  expect(await admin.fleet({ op: "pairing", scopes: ["read", "projects"] })).toEqual({
    refused: "forbidden",
  });
  await expect(
    accessRequest(f.server.httpUrl, "/v1/pairings", {
      method: "POST",
      token: admin.token,
      body: { scopes: ["read", "projects"] },
    }),
  ).rejects.toThrow("403");
});
