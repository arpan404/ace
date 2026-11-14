import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore, type Transport } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";

/*
 * What the shared client does with the two ways the native relay socket ends a hello the daemon
 * refused for its grant (`RelaySocket.admission`). A kept grant's refusal arrives as a lost
 * connection (1006), so the client reconnects, and the next socket presents a newly fetched
 * grant; a fetched grant's refusal arrives as the daemon's `unauthorized`, which stays final.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

/** A socket that opens, then ends the hello the way the native relay socket would. */
function refusing(end: "lost" | "unauthorized"): Transport {
  let events: Parameters<Transport["open"]>[0] | undefined;
  return {
    open(next) {
      events = next;
      queueMicrotask(() => next.open());
    },
    send(text) {
      if (!text.includes('"type":"hello"')) return;
      queueMicrotask(() => {
        if (end === "lost") events?.close(1006);
        else
          events?.message(
            JSON.stringify({ type: "error", code: "unauthorized", message: "Valid hello required" }),
          );
      });
    },
    close() {},
  };
}

function start(first: "lost" | "unauthorized") {
  const daemon = new FakeDaemon({
    clock: Date.now,
    hostId: "ios-test-host",
    token: "ios-test-token",
    displayName: "studio",
  });
  let opened = 0;
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-relay-grant-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => (opened++ === 0 ? refusing(first) : fakeTransport(daemon)),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  return { owner, opened: () => opened };
}

test("a kept grant the daemon refused costs one reconnect, which reaches the daemon", async () => {
  const { owner, opened } = start("lost");
  await owner.start();
  await until(() => owner.state === "ready");
  expect(opened()).toBe(2);
});

test("a fetched grant the daemon refused stops the connection without retrying", async () => {
  const { owner, opened } = start("unauthorized");
  await owner.start();
  await until(() => owner.state === "fatal");
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(owner.state).toBe("fatal");
  expect(opened()).toBe(1);
});
