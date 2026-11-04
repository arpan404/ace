import { expect, test } from "vitest";
import { remotePlan, type RemotePreferences } from "./remote-policy.ts";
import { directAdvertisement } from "./remote-direct-policy.ts";
import type { RemoteListener } from "./network.ts";

const hosted = "wss://relay.acehq.dev";
const own = "wss://relay.example.com/";
const config = { listen: "local" as const, listenOverride: false, hostedRelayUrl: hosted };
const on: RemotePreferences = {
  "remote.enabled": true,
  "remote.lan": true,
  "remote.tailscale": false,
  "remote.relay": false,
  "remote.relayUrl": "",
};
const relays = (plan: ReturnType<typeof remotePlan>) =>
  plan.relays.map(({ url, hosted, chosen, accountId }) => ({ url, hosted, chosen, accountId }));

test.each([
  {
    name: "a signed-in machine on Tailscale is also on ace's relay",
    preferences: { ...on, "remote.lan": false, "remote.tailscale": true },
    account: "acct",
    direct: { lan: false, tailscale: true },
    relays: [{ url: hosted, hosted: true, chosen: false, accountId: "acct" }],
  },
  {
    name: "a signed-in machine serves LAN, Tailscale and its own relay beside ace's",
    preferences: { ...on, "remote.tailscale": true, "remote.relay": true, "remote.relayUrl": own },
    account: "acct",
    direct: { lan: true, tailscale: true },
    relays: [
      { url: own, hosted: false, chosen: true, accountId: undefined },
      { url: hosted, hosted: true, chosen: false, accountId: "acct" },
    ],
  },
  {
    name: "a signed-out machine on the LAN registers on no relay",
    preferences: on,
    account: undefined,
    direct: { lan: true, tailscale: false },
    relays: [],
  },
  {
    name: "the relay turned on with no address is ace's relay, waiting for a sign-in",
    preferences: { ...on, "remote.relay": true },
    account: undefined,
    direct: { lan: true, tailscale: false },
    relays: [{ url: hosted, hosted: true, chosen: true, accountId: undefined }],
  },
  {
    name: "ace's relay named as the person's own is registered once",
    preferences: { ...on, "remote.relay": true, "remote.relayUrl": `${hosted}/` },
    account: "acct",
    direct: { lan: true, tailscale: false },
    relays: [{ url: `${hosted}/`, hosted: true, chosen: true, accountId: "acct" }],
  },
  {
    name: "remote access off runs nothing, signed in or not",
    preferences: { ...on, "remote.enabled": false, "remote.relay": true, "remote.relayUrl": own },
    account: "acct",
    direct: { lan: false, tailscale: false },
    relays: [],
  },
  {
    name: "a saved address with the relay off runs no relay of its own",
    preferences: { ...on, "remote.relayUrl": own },
    account: undefined,
    direct: { lan: true, tailscale: false },
    relays: [],
  },
])("$name", ({ preferences, account, direct, relays: expected }) => {
  const plan = remotePlan(config, preferences, account);
  expect(plan.direct).toEqual(direct);
  expect(relays(plan)).toEqual(expected);
});

test("launch overrides pin the listener and add their relay beside ace's", () => {
  const plan = remotePlan(
    { listen: "tailscale", listenOverride: true, relayUrl: own, hostedRelayUrl: hosted },
    { ...on, "remote.enabled": true, "remote.lan": true },
    "acct",
  );
  expect(plan.direct).toEqual({ lan: false, tailscale: true });
  expect(relays(plan).map((relay) => relay.url)).toEqual([own, hosted]);
});

test("another account is another registration on ace's relay", () => {
  const first = remotePlan(config, on, "first");
  const second = remotePlan(config, on, "second");
  expect(first.relays[0]?.key).not.toBe(second.relays[0]?.key);
  expect(remotePlan(config, on, "first").relays[0]?.key).toBe(first.relays[0]?.key);
});

const listener = (host: string, advertisedHost: string, tailnetName?: string): RemoteListener => ({
  host,
  advertisedHost,
  port: 4243,
  identity: { key: Buffer.alloc(0), cert: Buffer.alloc(0), fingerprint: "pin" },
  ...(tailnetName ? { tailnetName } : {}),
});

test.each([
  {
    name: "LAN and Tailscale share one listener on every address, and links name Tailscale",
    resolution: {
      lan: listener("0.0.0.0", "192.168.1.20"),
      tailscale: listener("100.64.0.1", "100.64.0.1", "mac.tail.ts.net"),
    },
    expected: {
      host: "0.0.0.0",
      advertisedHost: "100.64.0.1",
      tailnetName: "mac.tail.ts.net",
      serves: { lan: true, tailscale: true },
    },
  },
  {
    name: "Tailscale down leaves the LAN serving",
    resolution: { lan: listener("0.0.0.0", "192.168.1.20"), tailscale: new Error("down") },
    expected: {
      host: "0.0.0.0",
      advertisedHost: "192.168.1.20",
      serves: { lan: true, tailscale: false },
    },
  },
  {
    name: "Tailscale alone binds only its address",
    resolution: { tailscale: listener("100.64.0.1", "100.64.0.1") },
    expected: {
      host: "100.64.0.1",
      advertisedHost: "100.64.0.1",
      serves: { lan: false, tailscale: true },
    },
  },
])("$name", ({ resolution, expected }) => {
  expect(directAdvertisement(resolution)).toMatchObject(expected);
});

test("Tailscale down with Tailscale alone opens nothing: it never falls back to the LAN", () => {
  expect(directAdvertisement({ tailscale: new Error("down") })).toBeUndefined();
});
