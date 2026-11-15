import { afterEach, expect, it } from "vitest";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { linkProfile, startLinkShaper } from "@ace/perf-kit/link";
import { fixture } from "./socket-test-support.ts";
import { newClient, ready, recordedSockets } from "./relay-nk-test-support.ts";

// The 5-second confirmation deadline (ADR 0155, step 2) on slow, lossy phone links: the client
// confirms as soon as it has the daemon's answer, outside the flow window, so a legitimate NK
// session stays open on a 0.4 s and a 1 s round trip with loss stalls.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

it.each([400, 1_000])(
  "an NK session on a %i ms round trip with loss confirms within its deadline and stays open",
  async (rttMs) => {
    const relay = await startRelay({ port: 0, bind: "127.0.0.1" });
    cleanup.push(() => relay.close());
    const f = await fixture({ relay: { url: relay.url, keys: keyPair() } });
    cleanup.push(() => f.close());
    const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
    const upstream = new URL(relay.url);
    const shaper = await startLinkShaper({
      target: { host: upstream.hostname, port: Number(upstream.port) },
      // 3g-slow's bandwidth, loss and stall, at this round trip.
      profile: { ...linkProfile("3g-slow"), rttMs, loss: 0.05 },
      seed: rttMs,
    });
    cleanup.push(() => shaper.close());
    const shaped = new URL(relay.url);
    shaped.host = shaper.address;
    const sockets = recordedSockets();
    const client = newClient(
      cleanup,
      shaped.toString(),
      f.server.relayHostId ?? "",
      { id: paired.device.id, token: paired.token },
      sockets.socket,
    );
    const first = ready(client, 0, () => sockets.dials.length);
    await client.start();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 2 * rttMs));
    const again = ready(client, 1, () => sockets.dials.length);
    sockets.drop();
    await again;
    expect(sockets.patterns()).toEqual(["xx", "nk"]);
    // Past the deadline the session is still the same one: no close, no new dial.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(sockets.dials).toHaveLength(2);
    expect(client.connectionState().getSnapshot()).toBe("ready");
  },
  30_000,
);
