import { expect, test } from "vitest";
import { remoteNetworksStatus } from "./remote-status.ts";
import type { RelayPlan } from "./remote-policy.ts";

const own: RelayPlan = { url: "wss://relay.example", hosted: false, chosen: true, key: "own" };
const ace: RelayPlan = {
  url: "wss://relay.acehq.dev",
  hosted: true,
  chosen: false,
  accountId: "account",
  key: "ace",
};
const idle = {
  serving: { lan: false, tailscale: false },
  errors: {},
  address: () => undefined,
};

test("every network a start brings up reads waiting until it serves or fails", () => {
  const status = remoteNetworksStatus({
    direct: idle,
    // The sequential start has reached the person's relay, not yet ace's.
    relays: [{ plan: own, state: "waiting" }],
    pending: { direct: { lan: true, tailscale: true }, relays: [own, ace] },
  });
  expect(status.networks).toEqual({
    lan: { state: "waiting" },
    tailscale: { state: "waiting" },
    relay: { state: "waiting", address: own.url },
    account: { state: "waiting", address: ace.url },
  });
  expect(status).toMatchObject({ enabled: false, transport: "local" });
});

test("a pending start never hides a network that serves or failed, nor one it doesn't plan", () => {
  const status = remoteNetworksStatus({
    direct: {
      serving: { lan: true, tailscale: false },
      errors: { tailscale: "Start Tailscale on this computer, then try again." },
      address: (network) => (network === "lan" ? "https://192.168.1.4:4243" : undefined),
    },
    relays: [{ plan: own, state: "failed", error: "Couldn't reach the relay at relay.example." }],
    pending: { direct: { lan: true, tailscale: true }, relays: [own] },
  });
  expect(status.networks).toEqual({
    lan: { state: "on", address: "https://192.168.1.4:4243" },
    tailscale: { state: "failed", error: "Start Tailscale on this computer, then try again." },
    relay: {
      state: "failed",
      error: "Couldn't reach the relay at relay.example.",
      address: own.url,
    },
    account: { state: "off" },
  });
});
