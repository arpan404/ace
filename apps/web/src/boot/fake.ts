import {
  FakeDaemon,
  ScenarioPlayer,
  coldStartReplay,
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

const minute = 60_000;

/** A thread the reader "left" partway through, so its transcript shows a New activity divider. */
export interface SeenSeed {
  threadId: string;
  itemId: string;
}

/** `bun run --filter @ace/web dev:fake`: the whole app against scripted scenarios in-page. */
export function bootFake(): { client: Client; daemon: FakeDaemon; seen: SeenSeed[] } {
  const daemon = new FakeDaemon({ clock: () => Date.now(), snapshotItems: 40 });
  // Scenarios that happened earlier are stamped back by their age.
  new ScenarioPlayer(daemon, longHistory(120), { agoMs: 2 * 24 * 60 * minute }).runUntilBlocked();
  for (const aged of homeList())
    new ScenarioPlayer(daemon, aged.scenario, { agoMs: aged.agoMs }).runUntilBlocked();
  // Live threads keep moving while the app is open; they started a few minutes ago.
  new ScenarioPlayer(daemon, flakyCheckout(), { agoMs: 3 * minute }).autoplay(timer);
  new ScenarioPlayer(daemon, replayCursor(), { agoMs: 4 * minute }).autoplay(timer);
  // The thread the right and bottom panels are designed around (features/panels): its first
  // turns already happened, the subagents report back live.
  const coldStart = new ScenarioPlayer(daemon, coldStartReplay());
  coldStart.runThrough("relay-output");
  coldStart.autoplay(timer);
  new ScenarioPlayer(daemon, failingSubagent(), { agoMs: 12 * minute }).autoplay(timer, 0.5);
  const client = createBrowserClient({
    deviceId: "web-fake-device",
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: memoryStorage(),
  });
  // The hero thread was last read before reconnect-audit's finding arrived.
  const relay = daemon.itemId("thread-dedupe", "relay");
  const seen = relay ? [{ threadId: "thread-dedupe", itemId: relay }] : [];
  // Exposed for poking at fault injection from the console, e.g. ace.daemon.disconnectAll().
  Object.assign(globalThis, { ace: { daemon, client } });
  return { client, daemon, seen };
}
