import { expect, it } from "vitest";
import { machineCodeGate, type PathRoute } from "@ace/client";
import type { MachinePath } from "@ace/protocol";
import {
  accountMachineState,
  accountRoutes,
  type AccountMachineOptions,
} from "./account-machines.ts";

const idle = { asking: undefined, lockedUntil: undefined };

it("an account machine waiting for its code reads as asking, with the lock's end when locked", () => {
  expect(
    accountMachineState(
      { status: "machine_code" },
      { asking: "machine_code_locked", lockedUntil: 9000 },
    ),
  ).toEqual({ kind: "asking", reason: "machine_code_locked", lockedUntil: 9000 });
  expect(
    accountMachineState(
      { status: "machine_code" },
      { asking: "machine_code_wrong", lockedUntil: undefined },
    ),
  ).toEqual({ kind: "asking", reason: "machine_code_wrong" });
});

it("an account machine that retries by itself reads as connecting until it is online", () => {
  expect(accountMachineState({ status: "offline" }, idle)).toEqual({ kind: "connecting" });
  expect(accountMachineState({ status: "connecting" }, idle)).toEqual({ kind: "connecting" });
  // A code the person already entered is on its way: no prompt while it is checked.
  expect(accountMachineState({ status: "machine_code" }, idle)).toEqual({ kind: "connecting" });
  expect(accountMachineState({ status: "online" }, idle)).toEqual({ kind: "open" });
});

it("a refused or closed account machine reads as failed with why", () => {
  expect(
    accountMachineState(
      { status: "auth_failed", error: { message: "Sign in to ace again." } },
      idle,
    ),
  ).toEqual({ kind: "failed", message: "Sign in to ace again." });
  expect(accountMachineState(undefined, idle)).toMatchObject({ kind: "failed" });
});

const relayKey = "A".repeat(52);
function routesFor(paths: MachinePath[], directRoute?: AccountMachineOptions["directRoute"]) {
  const account: AccountMachineOptions = {
    relayUrl: "wss://relay.acehq.dev",
    deviceId: "phone",
    grant: async () => "grant",
    socket: () => {
      throw new Error("No sockets in this test");
    },
    client: () => {
      throw new Error("No clients in this test");
    },
    ...(directRoute ? { directRoute } : {}),
  };
  return accountRoutes({
    relayUrl: account.relayUrl,
    hostId: relayKey,
    account,
    gate: machineCodeGate(account.grant),
    scheduler: { set: () => () => {} },
    paths: () => paths,
  })().map((route) => route.path.key);
}

it("an account machine is reached through ace's relay, and through relays pinned to its own key", () => {
  expect(
    routesFor([
      { kind: "account", url: "wss://relay.acehq.dev", relayHostId: relayKey },
      { kind: "relay", url: "wss://relay.example", relayHostId: relayKey },
      // A relay naming another host key is not this machine's.
      { kind: "relay", url: "wss://elsewhere.example", relayHostId: "B".repeat(52) },
    ]),
  ).toEqual(["account wss://relay.acehq.dev", "relay wss://relay.example"]);
});

it("an account machine's direct paths are used only where the app can check the certificate", () => {
  const lan = {
    kind: "lan",
    url: "https://192.168.1.4:7443",
    fingerprint: "c".repeat(64),
  } as const;
  const tailnet = {
    kind: "tailscale",
    url: "https://box.tail1.ts.net:7443",
    fingerprint: "c".repeat(64),
  } as const;
  expect(routesFor([lan, tailnet])).toEqual(["account wss://relay.acehq.dev"]);
  const checked: PathRoute = {
    transport: () => {
      throw new Error("Not dialed");
    },
    credential: async () => "grant",
  };
  expect(
    routesFor([lan, tailnet], (path) => (path.kind === "tailscale" ? checked : undefined)),
  ).toEqual(["account wss://relay.acehq.dev", "tailscale https://box.tail1.ts.net:7443"]);
});
