import { expect, test } from "vitest";
import {
  browserChecksDirect,
  lastWinnerKey,
  pairedRoutes,
  pairedUrls,
  targetKind,
} from "./machine-routes.ts";

const fingerprint = "d".repeat(64);
const relayHostId = "A".repeat(52);
const target = {
  url: "wss://192.168.1.4:7443/",
  token: "e".repeat(64),
  pairedDeviceId: "laptop",
};
const advertised = [
  { kind: "loopback", url: "https://127.0.0.1:7443", fingerprint },
  { kind: "lan", url: "https://192.168.1.4:7443", fingerprint },
  { kind: "tailscale", url: "https://box.tail1.ts.net:7443", fingerprint },
  { kind: "tailscale", url: "https://100.64.0.2:7443", fingerprint },
  { kind: "account", url: "wss://relay.acehq.dev", relayHostId },
  { kind: "relay", url: "wss://relay.example", relayHostId },
  { kind: "satellite", url: "wss://future.example" },
];

test("a browser uses the paired address, Tailscale names it can check, and the person's relay", () => {
  expect(pairedRoutes(target, advertised).map((route) => route.path.key)).toEqual([
    "paired",
    "tailscale wss://box.tail1.ts.net:7443/",
    "relay wss://relay.example/",
  ]);
  expect(pairedUrls(target, advertised)).toEqual([
    "wss://192.168.1.4:7443/",
    "wss://box.tail1.ts.net:7443/",
    "wss://relay.example/",
  ]);
});

test.each([
  ["loopback", "https://127.0.0.1:7443", false],
  ["lan", "https://192.168.1.4:7443", false],
  ["tailscale", "https://100.64.0.2:7443", false],
  ["tailscale", "https://box.tail1.ts.net:7443", true],
] as const)("a browser checks a %s path at %s: %s", (kind, url, checks) => {
  expect(browserChecksDirect({ kind, url, fingerprint })).toBe(checks);
});

test.each([
  [{ url: "ws://127.0.0.1:7000/" }, "loopback"],
  [{ url: "wss://192.168.1.4:7443/" }, "lan"],
  [{ url: "wss://100.100.1.2:7443/" }, "tailscale"],
  [{ url: "wss://box.tail1.ts.net:7443/" }, "tailscale"],
  [{ url: "wss://relay.example/", relayHostId }, "relay"],
] as const)("a paired address %o is a %s path", (address, kind) => {
  expect(targetKind(address)).toBe(kind);
});

test("the race starts with the kind of path that won last time", () => {
  const routes = pairedRoutes(target, advertised);
  expect(lastWinnerKey(routes, "relay")).toBe("relay wss://relay.example/");
  expect(lastWinnerKey(routes, "lan")).toBe("paired");
  expect(lastWinnerKey(routes, "carrier-pigeon")).toBeUndefined();
});
