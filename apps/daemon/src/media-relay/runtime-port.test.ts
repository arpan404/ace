import { expect, it } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { defaultMediaSettings, systemMediaClock, type MediaHost } from "@ace/media/supervisor";
import { keyPair } from "@ace/secure-channel";
import { daemonDelivery } from "../services/media.ts";
import { lateMediaRelay } from "./port.ts";
import { RuntimeRelayPort } from "./runtime-port.ts";

// The relay port the daemon hands out is one per ace-media runtime: looking delivery up again
// (every send, claim and availability check does) must not add a watcher each time.

const neverStarted: MediaHost = {
  spawn: () => {
    throw new Error("ace-media isn't started in this test");
  },
  connect: () => {
    throw new Error("ace-media isn't started in this test");
  },
};

function runtime() {
  return new MediaRuntime({
    version: "0.0.0-test",
    binary: "/nonexistent/ace-media",
    runtimeDir: "/nonexistent",
    dataDir: "/nonexistent",
    settings: () => defaultMediaSettings,
    host: neverStarted,
    clock: systemMediaClock,
    random: () => 0,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => "id",
    log: () => {},
  });
}

it("repeated lookups through the delivery factory keep one watcher, and each message reaches the streams once", () => {
  const live = runtime();
  const port = new RuntimeRelayPort(live);
  const relay = lateMediaRelay(() => daemonDelivery(live, port).relay, {
    hostKeys: keyPair(),
  });
  for (let i = 0; i < 50; i++)
    expect(relay.claim("A".repeat(43), { device: "phone", admission: "pairing" })).toBeUndefined();
  expect(port.watchers).toBe(1);
  live.dispose();
});

it("a watcher that unsubscribes hears nothing more", () => {
  const live = runtime();
  const port = new RuntimeRelayPort(live);
  let heard = 0;
  const stop = port.watch({ message: () => heard++, exit: () => heard++ });
  port.message({ type: "relay.dialed", stream: "s" }, new Uint8Array(0));
  stop();
  port.message({ type: "relay.dialed", stream: "s" }, new Uint8Array(0));
  port.exit();
  expect(heard).toBe(1);
  expect(port.watchers).toBe(0);
  live.dispose();
});
