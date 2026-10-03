import {
  FakeDaemon,
  ScenarioPlayer,
  failingSubagent,
  fakeTransport,
  flakyCheckout,
  longHistory,
  homeList,
  replayCursor,
} from "@ace/fake-daemon";
import type { Client } from "@ace/client";
import { createBrowserClient, memoryStorage } from "./client.ts";

const timer = {
  set(delayMs: number, callback: () => void) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

/** `bun run --filter @ace/web dev:fake`: the whole app against scripted scenarios in-page. */
export function bootFake(): { client: Client; daemon: FakeDaemon } {
  // Scenarios that happened earlier are played with the daemon clock set back by their age.
  let agoMs = 0;
  const daemon = new FakeDaemon({ clock: () => Date.now() - agoMs, snapshotItems: 40 });
  new ScenarioPlayer(daemon, longHistory(120)).runUntilBlocked();
  for (const aged of homeList()) {
    agoMs = aged.agoMs;
    new ScenarioPlayer(daemon, aged.scenario).runUntilBlocked();
  }
  agoMs = 0;
  const checkout = new ScenarioPlayer(daemon, flakyCheckout());
  const settings = new ScenarioPlayer(daemon, failingSubagent());
  checkout.autoplay(timer);
  new ScenarioPlayer(daemon, replayCursor()).autoplay(timer);
  settings.autoplay(timer, 0.5);
  const client = createBrowserClient({
    deviceId: "web-fake-device",
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
  });
  // Exposed for poking at fault injection from the console, e.g. ace.daemon.disconnectAll().
  Object.assign(globalThis, { ace: { daemon, client } });
  return { client, daemon };
}
