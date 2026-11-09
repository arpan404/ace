import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { remoteRelays, type RelayAccess } from "./remote-relays.ts";
import type { RelayPlan } from "./remote-policy.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const plan: RelayPlan = {
  url: "wss://relay.example",
  hosted: false,
  chosen: true,
  key: "wss://relay.example",
};

/** The relays with a connection the test controls: it fails or registers when told. */
async function controlled(connect: (access: RelayAccess) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ace-relays-"));
  homes.push(home);
  const logged: string[] = [];
  const opened: RelayAccess[] = [];
  const relays = remoteRelays({
    options: {
      remoteConfig: readConfig({ ACE_HOME: home, ACE_PORT: "0" }),
      log: (error) => logged.push(error instanceof Error ? error.message : String(error)),
    },
    connect: async (_relay, access) => {
      opened.push(access);
      await connect(access);
      return { relayHostId: "host", close: async () => {} };
    },
    machineName: async () => "Studio",
    serialize: (work) => work(),
    clearPending: () => {},
  });
  const state = () => relays.view().map((view) => ({ state: view.state, error: view.error }));
  return { relays, state, logged, opened };
}

it("a relay is on only while its registration holds, and waits with a plain reason while it registers again", async () => {
  const { relays, state, logged, opened } = await controlled(async () => {});
  await relays.apply([plan]);
  expect(state()).toEqual([{ state: "on", error: undefined }]);
  const registration = opened[0]?.onRegistration;
  if (!registration) throw new Error("No registration events");

  registration(false);
  expect(state()).toEqual([
    {
      state: "waiting",
      error: "Lost the connection to the relay at relay.example. Reconnecting.",
    },
  ]);
  // The connection registers again by itself: a timer never opens a second one beside it.
  expect(relays.retryable()).toBe(false);
  await relays.apply([plan]);
  expect(opened).toHaveLength(1);
  expect(relays.relayHostId()).toBe("host");

  registration(true);
  expect(state()).toEqual([{ state: "on", error: undefined }]);
  expect(logged).toEqual(["Lost the connection to the relay at relay.example. Reconnecting."]);
});

it("a relay that can't be reached is logged once however often it is retried, and comes on when it answers", async () => {
  let reachable = false;
  const { relays, state, logged } = await controlled(async () => {
    if (!reachable) throw new Error("ECONNREFUSED");
  });
  for (let attempt = 0; attempt < 3; attempt++) await relays.apply([plan]);
  expect(state()).toEqual([
    { state: "failed", error: "Couldn't reach the relay at relay.example." },
  ]);
  expect(relays.retryable()).toBe(true);
  expect(logged).toEqual(["Couldn't reach the relay at relay.example."]);

  reachable = true;
  await relays.apply([plan]);
  expect(state()).toEqual([{ state: "on", error: undefined }]);
  expect(relays.retryable()).toBe(false);
});

it("a registration that was stopped can't change the one that replaced it", async () => {
  const { relays, state, opened } = await controlled(async () => {});
  await relays.apply([plan]);
  const stale = opened[0]?.onRegistration;
  await relays.apply([]);
  await relays.apply([plan]);
  expect(opened).toHaveLength(2);
  stale?.(false);
  expect(state()).toEqual([{ state: "on", error: undefined }]);
});
