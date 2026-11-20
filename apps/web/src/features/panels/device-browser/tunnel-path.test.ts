import { describe, expect, it } from "vitest";
import type { MachineEntry } from "@ace/client/machines";
import { DeviceId, HostId } from "@ace/protocol";
import { tunnelPathFor } from "./tunnel-path.ts";

const relayHostId = "A".repeat(52);
const entry = (target: MachineEntry["target"], paths?: MachineEntry["paths"]): MachineEntry => ({
  hostId: HostId.parse("host-b"),
  displayName: "Studio",
  deviceId: DeviceId.parse("device-1"),
  target,
  ...(paths ? { paths } : {}),
});
const paired = entry({ kind: "direct", url: "https://studio.tail.ts.net:7443/" }, [
  { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: "a".repeat(64) },
  { kind: "relay", url: "wss://relay.example.com", relayHostId },
]);

describe("the path a machine's tunnel opens on", () => {
  it("follows the path the machine connection is on", () => {
    expect(tunnelPathFor({ entry: paired, online: true, path: "lan", token: "t" })).toEqual({
      key: "lan:wss://192.168.1.4:7443/",
      target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
      deviceId: "device-1",
      token: "t",
    });
  });

  it("takes the relay, pinned to the machine's key, when the connection is on it", () => {
    expect(tunnelPathFor({ entry: paired, online: true, path: "relay", token: "t" })).toMatchObject(
      {
        key: "relay:wss://relay.example.com/",
        target: { kind: "relay", url: "wss://relay.example.com/", hostId: relayHostId },
      },
    );
  });

  it("falls back to the paired address when the path in use isn't one it knows", () => {
    expect(
      tunnelPathFor({ entry: paired, online: true, path: undefined, token: "t" }),
    ).toMatchObject({
      target: { kind: "direct", url: "wss://studio.tail.ts.net:7443/" },
    });
  });

  it("uses a relay pairing's pinned key", () => {
    const relayed = entry({
      kind: "relay",
      url: "wss://relay.example.com/",
      ticketReference: relayHostId,
    });
    expect(
      tunnelPathFor({ entry: relayed, online: true, path: undefined, token: "t" }),
    ).toMatchObject({
      target: { kind: "relay", hostId: relayHostId },
    });
  });

  it.each([
    ["offline", { entry: paired, online: false, path: undefined, token: "t" }],
    ["without its credential", { entry: paired, online: true, path: undefined, token: undefined }],
    [
      "reached only through the account",
      {
        entry: entry({ kind: "account", relayUrl: "wss://relay.acehq.dev/" }),
        online: true,
        path: undefined,
        token: "t",
      },
    ],
  ])("has none while %s", (_name, machine) => {
    expect(tunnelPathFor(machine)).toBeUndefined();
  });
});
