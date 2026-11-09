import { expect, test } from "vitest";
import { HostId } from "@ace/protocol";
import { pairedMachineFrom } from "./pair-machine.ts";

const identity = { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" };
const target = { url: "wss://192.168.1.4:7443/", token: "e".repeat(64), pairedDeviceId: "browser" };

test("a browser pairing keeps the fingerprint the daemon gave for the address it paired at", () => {
  const paired = pairedMachineFrom(
    target,
    identity,
    [
      { kind: "tailscale", url: "https://box.tail1.ts.net:7443", fingerprint: "d".repeat(64) },
      { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: "c".repeat(64) },
      { kind: "account", url: "wss://relay.acehq.dev", relayHostId: "A".repeat(52) },
    ],
    false,
  );
  expect(paired.target).toEqual({
    kind: "direct",
    url: "wss://192.168.1.4:7443/",
    fingerprint: "c".repeat(64),
  });
});

test("a browser pairing names no fingerprint the daemon didn't give for that address", () => {
  const paired = pairedMachineFrom(
    target,
    identity,
    [{ kind: "lan", url: "https://192.168.1.9:7443", fingerprint: "c".repeat(64) }],
    false,
  );
  expect(paired.target).toEqual({ kind: "direct", url: "wss://192.168.1.4:7443/" });
});
