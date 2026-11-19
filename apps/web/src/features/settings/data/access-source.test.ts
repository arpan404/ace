import { ClientError, type ClientApi } from "@ace/client";
import type { Device, FleetOperation, FleetOutcome, RemoteAccessStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { unavailableGaps } from "./access-gaps.ts";
import { accessOrigin, accessSource } from "./access-source.ts";

/** A machine's connection answering `fleet.request` as its daemon would, direct or relayed. */
function machine(answer: (operation: FleetOperation) => FleetOutcome | ClientError) {
  const request = async (input: { type: string; operation: FleetOperation }) => {
    if (input.type !== "fleet.request") throw new Error(`Unexpected ${input.type}`);
    const result = answer(input.operation);
    if (result instanceof ClientError) throw result;
    return { type: "fleet.result", requestId: "r", result };
  };
  // Only fleet requests are ever sent through this stub.
  return accessSource({ request: request as unknown as ClientApi["request"] }, unavailableGaps());
}

const refusing = (code: string) => machine(() => new ClientError("daemon", code));

const relayed: RemoteAccessStatus = {
  enabled: true,
  transport: "relay",
  listenOverride: null,
  relayOverride: false,
  relay: { url: "wss://relay.example/", fingerprint: "A".repeat(52), hostId: "studio" },
  account: { signedIn: true, machineCode: { set: false } },
};

const device = (id: string, scopes: Device["scopes"], revokedAt: number | null = null): Device => ({
  id: id as Device["id"],
  name: id,
  scopes,
  createdAt: 1,
  lastSeenAt: 2,
  revokedAt,
});

test("the daemon's HTTP routes live on the same host and port as its socket", () => {
  expect(accessOrigin("ws://127.0.0.1:4242/")).toBe("http://127.0.0.1:4242/");
  expect(accessOrigin("wss://studio-mac.tailnet.ts.net:7417/")).toBe(
    "https://studio-mac.tailnet.ts.net:7417/",
  );
});

test("remote access status comes over the machine's own connection, so it reads through a relay", async () => {
  const access = machine((operation) =>
    operation.op === "remoteStatus"
      ? { kind: "remoteStatus", status: relayed }
      : new ClientError("daemon", "invalid"),
  );

  expect(await access.remoteStatus()).toEqual(relayed);
});

test("a pairing carries the one-time code from its link, for typing by hand", async () => {
  const asked: FleetOperation[] = [];
  const access = machine((operation) => {
    asked.push(operation);
    return {
      kind: "pairing",
      id: "p1",
      url: "https://app.acehq.dev/pair#relay=wss%3A%2F%2Frelay.example&code=ABCD-EFGH",
      code: "ABCD-EFGH",
      expiresAt: 5_000,
    };
  });

  const pairing = await access.pair(["read", "operate", "desktop"]);

  expect(pairing).toMatchObject({ code: "ABCD-EFGH", expiresAt: 5_000 });
  // Local credentials are never something a pairing link grants.
  expect(asked).toEqual([{ op: "pairing", scopes: ["read", "operate"] }]);
});

test("the desktop app's own credentials and revoked devices aren't listed as paired devices", async () => {
  const access = machine(() => ({
    kind: "devices",
    devices: [
      device("Pixel", ["read", "operate"]),
      device("desk", ["desktop"]),
      device("chrome", ["user-browser"]),
      device("Old phone", ["read"], 3),
    ],
  }));

  expect((await access.devices()).map((entry) => entry.name)).toEqual(["Pixel"]);
});

test("revoking a device asks the machine it is paired to", async () => {
  const revoked: string[] = [];
  const access = machine((operation) => {
    if (operation.op !== "revoke") return new ClientError("daemon", "invalid");
    revoked.push(operation.deviceId);
    return { kind: "revoked" };
  });

  await access.revoke("phone-1");

  expect(revoked).toEqual(["phone-1"]);
});

test("refusals say what to do in words", async () => {
  await expect(refusing("forbidden").devices()).rejects.toThrow("administrator access");
  await expect(refusing("unavailable").pair(["read"])).rejects.toThrow(
    /Turn on remote access above/,
  );
  await expect(refusing("not_found").revoke("gone")).rejects.toThrow("no longer paired");
  await expect(machine(() => new ClientError("offline")).remoteStatus()).rejects.toThrow(
    "Couldn't reach this machine",
  );
});

test("without a connection, access asks to connect first", async () => {
  await expect(accessSource(undefined, unavailableGaps()).devices()).rejects.toThrow(
    "Connect to your computer first.",
  );
});
