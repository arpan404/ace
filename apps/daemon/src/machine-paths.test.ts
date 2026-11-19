import { expect, test } from "vitest";
import type { RemoteAccessStatus } from "@ace/protocol";
import { machinePaths } from "./machine-paths.ts";

const fingerprint = "a".repeat(64);
const relayHostId = "A".repeat(52);
const off = { state: "off" };
function status(
  networks: Partial<NonNullable<RemoteAccessStatus["networks"]>>,
): RemoteAccessStatus {
  return {
    enabled: true,
    transport: "lan",
    listenOverride: null,
    relayOverride: false,
    relay: { url: "wss://relay.example", fingerprint: relayHostId, hostId: "host" },
    networks: { lan: off, tailscale: off, relay: off, account: off, ...networks },
  };
}

test("a machine on every network names each path with the pin that proves it", () => {
  const paths = machinePaths(
    status({
      lan: { state: "on", address: "https://192.168.1.4:7443" },
      tailscale: { state: "on", address: "https://box.tail1.ts.net:7443" },
      relay: { state: "on", address: "wss://relay.example" },
      account: { state: "on", address: "wss://relay.acehq.dev" },
    }),
    fingerprint,
  );
  expect(paths).toEqual([
    { kind: "loopback", url: "https://127.0.0.1:7443", fingerprint },
    { kind: "lan", url: "https://192.168.1.4:7443", fingerprint },
    { kind: "tailscale", url: "https://box.tail1.ts.net:7443", fingerprint },
    { kind: "account", url: "wss://relay.acehq.dev", relayHostId },
    { kind: "relay", url: "wss://relay.example", relayHostId },
  ]);
});

test("networks that are off, failed or waiting are not paths", () => {
  const paths = machinePaths(
    status({
      lan: { state: "failed", error: "port taken" },
      tailscale: { state: "on", address: "https://100.64.0.2:7443" },
      account: { state: "waiting", address: "wss://relay.acehq.dev" },
    }),
    fingerprint,
  );
  expect(paths.map((path) => path.kind)).toEqual(["tailscale"]);
});

test("Tailscale alone binds only its own address, so the same computer is not a path", () => {
  const paths = machinePaths(
    status({ tailscale: { state: "on", address: "https://100.64.0.2:7443" } }),
    fingerprint,
  );
  expect(paths.some((path) => path.kind === "loopback")).toBe(false);
});

test("ace's relay named as the person's own is one path", () => {
  const paths = machinePaths(
    status({
      relay: { state: "on", address: "wss://relay.acehq.dev" },
      account: { state: "on", address: "wss://relay.acehq.dev" },
    }),
    fingerprint,
  );
  expect(paths).toEqual([{ kind: "account", url: "wss://relay.acehq.dev", relayHostId }]);
});

test("a direct network without its pin is never named", () => {
  const paths = machinePaths(
    status({ lan: { state: "on", address: "https://192.168.1.4:7443" } }),
    undefined,
  );
  expect(paths).toEqual([]);
});
