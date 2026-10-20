import { describe, expect, it } from "vitest";
import type { DeviceTransport } from "@ace/devices/client";
import { failoverTransport } from "./device-route.ts";

type Events = Parameters<DeviceTransport["open"]>[0];

/** A route that the test opens, welcomes or drops by hand, recording what it was sent. */
function route() {
  let events: Events | undefined;
  const sent: unknown[] = [];
  let closed = 0;
  const transport: DeviceTransport = {
    open(next) {
      events = next;
    },
    send(message) {
      sent.push(message);
    },
    close() {
      closed++;
    },
  };
  return {
    transport,
    sent,
    closed: () => closed,
    opened: () => events !== undefined,
    welcome: () => events?.ready(),
    deliver: (data: unknown) => events?.message(data),
    drop: () => events?.close(),
  };
}

function host() {
  const seen: string[] = [];
  const events: Events = {
    ready: () => seen.push("ready"),
    message: (data) => seen.push(`message ${String(data)}`),
    close: () => seen.push("close"),
  };
  return { seen, events };
}

const request = { type: "devices.request", requestId: "r1", operation: { op: "list" } } as const;

describe("a devices channel with a relay to fall back on", () => {
  it("uses the daemon's own address when it opens, and never touches the relay", async () => {
    const direct = route();
    let asked = 0;
    const routes: string[] = [];
    const channel = failoverTransport(
      direct.transport,
      async () => {
        asked++;
        return route().transport;
      },
      (which) => routes.push(which),
    );
    const { seen, events } = host();
    channel.open(events);
    direct.welcome();
    direct.deliver("frame");
    await channel.send(request);
    direct.drop();
    await Promise.resolve();
    expect(seen).toEqual(["ready", "message frame", "close"]);
    expect(direct.sent).toEqual([request]);
    expect(routes).toEqual(["primary"]);
    expect(asked).toBe(0);
  });

  it("goes through the relay when the address closes before the daemon answers", async () => {
    const direct = route();
    const relay = route();
    const routes: string[] = [];
    const channel = failoverTransport(
      direct.transport,
      async () => relay.transport,
      (which) => routes.push(which),
    );
    const { seen, events } = host();
    channel.open(events);
    direct.drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.opened()).toBe(true);
    expect(seen).toEqual([]);
    relay.welcome();
    await channel.send(request);
    relay.deliver("frame");
    expect(seen).toEqual(["ready", "message frame"]);
    expect(relay.sent).toEqual([request]);
    expect(direct.sent).toEqual([]);
    expect(routes).toEqual(["fallback"]);
    // The relay dropping later is a plain close: no third attempt.
    relay.drop();
    expect(seen.at(-1)).toBe("close");
  });

  it("closes when there is no relay to try", async () => {
    const direct = route();
    const channel = failoverTransport(direct.transport, async () => undefined);
    const { seen, events } = host();
    channel.open(events);
    direct.drop();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["close"]);
  });

  it("closing the channel while the relay route is still being looked up opens nothing", async () => {
    const direct = route();
    const relay = route();
    const lookup = Promise.withResolvers<DeviceTransport>();
    const channel = failoverTransport(direct.transport, () => lookup.promise);
    const { seen, events } = host();
    channel.open(events);
    direct.drop();
    channel.close();
    lookup.resolve(relay.transport);
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.opened()).toBe(false);
    expect(seen).toEqual([]);
  });
});
