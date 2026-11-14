import { expect, test } from "vitest";
import type { PortableSocket } from "./portable-relay.ts";
import { relayRoute } from "./relay-route.ts";

/**
 * A relay socket that fails: before its WebSocket upgrade (as a refused grant does in a
 * browser), or after the upgrade succeeded (the pairing or Noise handshake never finishes).
 */
const failingSocket = (upgrades: boolean) => (): PortableSocket => {
  type Listener = (event: { data: unknown; code?: number; reason?: string }) => void;
  const listeners = new Map<string, Listener[]>();
  const fire = (type: string) => {
    for (const run of listeners.get(type) ?? []) run({ data: undefined });
  };
  queueMicrotask(() => {
    if (upgrades) fire("open");
    queueMicrotask(() => {
      if (!upgrades) fire("error");
      fire("close");
    });
  });
  return {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    addEventListener(type: "open" | "error" | "message" | "close", listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    send() {},
    close() {},
  };
};

/** Open one attempt on `route` and wait for it to close. */
function attempt(relay: ReturnType<typeof relayRoute>): Promise<number> {
  return new Promise((resolve) =>
    relay.transport().open({ open: () => {}, message: () => {}, close: (code) => resolve(code) }),
  );
}

/** A relay route whose attempts fail as `upgrades` says, one per entry, each offering `grants`. */
function refusingRoute(grants: string[], upgrades: boolean[] = []) {
  const refused: string[] = [];
  const relay = relayRoute({
    relayUrl: "wss://relay.invalid",
    hostId: "A".repeat(52),
    credential: async () => ({ grant: grants.shift() ?? "grant-x" }),
    socket: () => failingSocket(upgrades.shift() ?? false)(),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    grantRefused: (grant) => {
      refused.push(grant);
      return false;
    },
  });
  return { relay, refused };
}

test("a grant whose relay upgrade fails twice in a row is reported refused, once is not", async () => {
  const { relay, refused } = refusingRoute(["grant-1", "grant-1", "grant-1"]);
  await attempt(relay);
  // One failed upgrade reads as any drop on a flaky link: the grant stays.
  expect(refused).toEqual([]);
  await attempt(relay);
  expect(refused).toEqual(["grant-1"]);
});

test("upgrades that fail with different grants report none of them", async () => {
  const { relay, refused } = refusingRoute(["grant-1", "grant-2", "grant-3"]);
  await attempt(relay);
  await attempt(relay);
  await attempt(relay);
  expect(refused).toEqual([]);
});

test("attempts whose upgrade succeeded but whose handshake failed never name the grant", async () => {
  const { relay, refused } = refusingRoute(["grant-1", "grant-1", "grant-1"], [true, true, true]);
  await attempt(relay);
  await attempt(relay);
  await attempt(relay);
  // A daemon or relay outage after the upgrade says nothing about the grant.
  expect(refused).toEqual([]);
});

test("an attempt that got past the upgrade resets the count of failed upgrades", async () => {
  const { relay, refused } = refusingRoute(
    ["grant-1", "grant-1", "grant-1", "grant-1"],
    [false, true, false, false],
  );
  await attempt(relay);
  await attempt(relay);
  await attempt(relay);
  expect(refused).toEqual([]);
  // Two failed upgrades in a row again: now it is named.
  await attempt(relay);
  expect(refused).toEqual(["grant-1"]);
});
