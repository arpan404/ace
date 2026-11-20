import { describe, expect, it } from "vitest";
import type { MachineEntry } from "@ace/client/machines";
import { DeviceId, HostId } from "@ace/protocol";
import { tunnelPathFor } from "./tunnel-path.ts";

const relayHostId = "A".repeat(52);
const lanPin = "a".repeat(64);
const pairedPin = "b".repeat(64);
const entry = (target: MachineEntry["target"], paths?: MachineEntry["paths"]): MachineEntry => ({
  hostId: HostId.parse("host-b"),
  displayName: "Studio",
  deviceId: DeviceId.parse("device-1"),
  target,
  ...(paths ? { paths } : {}),
});
// Paired over the LAN with its pin; the machine also named a ts.net name and its relay.
const paired = entry({ kind: "direct", url: "https://192.168.1.4:7443/", fingerprint: pairedPin }, [
  { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: lanPin },
  { kind: "tailscale", url: "https://studio.tail.ts.net:7443", fingerprint: lanPin },
  { kind: "lan", url: "https://10.0.0.9:7443", fingerprint: lanPin },
  { kind: "relay", url: "wss://relay.example.com", relayHostId },
]);

describe("the path a machine's tunnel opens on", () => {
  it("is the paired address the connection is on, pinned, proving the machine, with no token in the URL", () => {
    expect(tunnelPathFor({ entry: paired, online: true, path: "lan", token: "t" })).toEqual({
      key: "lan:wss://192.168.1.4:7443/",
      target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint: pairedPin },
      expectedHostId: "host-b",
      deviceId: "device-1",
      token: "t",
    });
  });

  it("follows the connection onto a ts.net path, pinned to what the machine named for it", () => {
    expect(
      tunnelPathFor({ entry: paired, online: true, path: "tailscale", token: "t" }),
    ).toMatchObject({
      target: { kind: "direct", url: "wss://studio.tail.ts.net:7443/", fingerprint: lanPin },
    });
  });

  it("takes the relay, pinned to the daemon's key, when the connection is on it", () => {
    expect(tunnelPathFor({ entry: paired, online: true, path: "relay", token: "t" })).toMatchObject(
      {
        key: "relay:wss://relay.example.com/",
        target: { kind: "relay", url: "wss://relay.example.com/", hostKey: relayHostId },
        expectedHostId: "host-b",
      },
    );
  });

  it("uses a relay pairing's pinned key", () => {
    const relayed = entry({
      kind: "relay",
      url: "wss://relay.example.com/",
      ticketReference: relayHostId,
    });
    expect(
      tunnelPathFor({ entry: relayed, online: true, path: undefined, token: "t" }),
    ).toMatchObject({ target: { kind: "relay", hostKey: relayHostId } });
  });

  it("pins a paired address with no fingerprint of its own by what the machine named for it", () => {
    const trusted = entry({ kind: "direct", url: "https://192.168.1.4:7443/" }, [
      { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: lanPin },
    ]);
    expect(tunnelPathFor({ entry: trusted, online: true, path: "lan", token: "t" })).toMatchObject({
      target: { fingerprint: lanPin },
    });
  });

  it.each([
    ["offline", { entry: paired, online: false, path: "lan" as const, token: "t" }],
    [
      "without its credential",
      { entry: paired, online: true, path: "lan" as const, token: undefined },
    ],
    [
      "on a path the connection doesn't say, among several",
      { entry: paired, online: true, path: undefined, token: "t" },
    ],
    [
      "on a direct address it can't pin",
      {
        entry: entry({ kind: "direct", url: "https://192.168.1.4:7443/" }),
        online: true,
        path: "lan" as const,
        token: "t",
      },
    ],
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

  it("never uses a LAN address the worker doesn't dial", () => {
    // 10.0.0.9 is named by the machine, but a browser can't check its certificate: the worker
    // only dials the paired LAN address, so that is the one the tunnel may use.
    const result = tunnelPathFor({ entry: paired, online: true, path: "lan", token: "t" });
    expect(result?.target.url).toBe("wss://192.168.1.4:7443/");
  });
});
