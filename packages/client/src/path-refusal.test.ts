import { DeviceId, type MachinePathKind } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import { racingTransport, type MachineRoute } from "./path-race.ts";
import { ManualScheduler } from "./test-support.ts";
import { defaultLimits, type TransportEvents } from "./types.ts";

/** A path whose sockets, one per connection attempt, the test opens, drops or refuses. */
function scriptedPath(kind: MachinePathKind) {
  const sockets: TransportEvents[] = [];
  const route: MachineRoute = {
    path: { key: kind, kind },
    credential: async () => "a".repeat(64),
    transport: () => ({
      open: (events) => void sockets.push(events),
      send() {},
      close() {},
    }),
  };
  const latest = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error(`no ${kind} socket`);
    return socket;
  };
  return { route, sockets, latest };
}

/** A client whose every attempt races a direct path and ace's relay, on manual time. */
function client() {
  const scheduler = new ManualScheduler();
  const direct = scriptedPath("lan");
  const relay = scriptedPath("relay");
  const instance = new Client({
    deviceId: DeviceId.parse("away-device"),
    transport: () =>
      racingTransport({
        routes: [direct.route, relay.route],
        scheduler,
        won: () => {},
        failed: () => {},
      }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler,
    random: () => 0.5,
    id: () => crypto.randomUUID(),
    limits: { ...defaultLimits, retryBaseMs: 1_000, retryCapMs: 1_000 },
  });
  return { client: instance, scheduler, direct, relay };
}

test("a machine the relay says is on another account, while the direct path is out, keeps retrying and says why until a path works", async () => {
  const { client: c, scheduler, direct, relay } = client();
  await c.start();
  scheduler.advance(150);
  // Away from home: the relay finds the machine on another account; the direct path is out.
  relay.latest().close(4403, "Not your machine");
  direct.latest().close(1006);
  expect(c.state).toBe("reconnecting");
  expect(c.error?.message).toBe("Not your machine");

  // Back home: the next attempt's direct path answers.
  scheduler.advance(1_000);
  expect(direct.sockets).toHaveLength(2);
  direct.latest().open();
  await Promise.resolve();
  direct
    .latest()
    .message(JSON.stringify({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 }));
  await expect.poll(() => c.state).toBe("ready");
  expect(c.error).toBeUndefined();
  await c.close();
});

test("a machine every path refuses stops with the refusal instead of retrying", async () => {
  const { client: c, scheduler, direct, relay } = client();
  await c.start();
  scheduler.advance(150);
  relay.latest().close(4403, "Not your machine");
  direct.latest().close(4001, "Credential refused");
  expect(c.state).toBe("fatal");
  await c.close();
});
