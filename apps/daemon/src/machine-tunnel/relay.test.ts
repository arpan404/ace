import { afterEach, expect, test } from "vitest";
import { attachPreviewRelay } from "@ace/preview";
import type { ServerMessage } from "@ace/protocol";
import { AcePorts } from "./ace-ports.ts";
import { createTunnelHost, type TunnelAttachment } from "./host.ts";
import { machinePortWatch } from "./port-feed.ts";
import { serveRelayTunnel } from "./relay.ts";

/*
 * A tunnel connection through a relay (ADR 0194), refused by the relay while its welcome is still
 * being sent: the real tunnel host, behind a relay channel that keeps one ordered send queue and
 * holds the welcome until the test lets it go.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.min(ms, 20));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function tunnelHost() {
  const acePorts = new AcePorts({ published: () => [], now: () => performance.now() });
  const host = createTunnelHost({
    enabled: async () => true,
    watchEnabled: () => () => {},
    acePorts,
    ports: machinePortWatch({
      scan: async () => ({ listening: new Set<number>(), owned: new Set<number>() }),
      acePorts,
      now: () => performance.now(),
      wait,
      limit: 1024,
      onError: () => {},
    }),
    wait,
    now: () => performance.now(),
    loadMux: async () => attachPreviewRelay,
  });
  cleanups.push(() => host.close());
  return host;
}

/** A relay channel whose sends go out in order, the welcome only once `releaseWelcome` runs. */
function relayChannel() {
  const sent: ServerMessage[] = [];
  const { promise: welcomeHeld, resolve: releaseWelcome } = Promise.withResolvers<void>();
  const { promise: closed, resolve: close } = Promise.withResolvers<void>();
  let queue = Promise.resolve();
  const channel = {
    send(message: ServerMessage) {
      queue = queue.then(async () => {
        if (message.type === "welcome") await welcomeHeld;
        sent.push(message);
      });
      return queue;
    },
    sendBinary: async () => {},
    close: () => close(),
    async *frames(): AsyncGenerator<Uint8Array | { type: "ping" }> {
      await closed;
    },
    bufferedBytes: 0,
    bufferedReceiveBytes: 0,
  };
  return { channel, sent, releaseWelcome, closed };
}

test("a device the relay refuses while its welcome is being sent hears the refusal after the welcome", async () => {
  const relay = relayChannel();
  let attachment: TunnelAttachment | undefined;
  const served = serveRelayTunnel(relay.channel, tunnelHost(), {
    device: "phone",
    operate: () => true,
    welcome: { type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 0 },
    attached: (held) => {
      attachment = held;
    },
  });
  // The device is revoked before its welcome has gone.
  await Promise.resolve();
  expect(relay.sent).toEqual([]);
  attachment?.refuse("tunnel_forbidden");
  relay.releaseWelcome();
  await served;
  await relay.closed;
  expect(relay.sent.map((message) => message.type)).toEqual(["welcome", "tunnel.refused"]);
  expect(relay.sent[1]).toEqual({ type: "tunnel.refused", code: "tunnel_forbidden" });
});
