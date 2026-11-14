import { expect, test } from "vitest";
import type { PortableSocket } from "./portable-relay.ts";
import { relayRoute } from "./relay-route.ts";

/** A relay whose WebSocket upgrade always fails, as a refused grant does in a browser. */
const refusingSocket = (): PortableSocket => {
  type Listener = (event: { data: unknown; code?: number; reason?: string }) => void;
  const failed: Listener[] = [];
  queueMicrotask(() => {
    for (const run of failed) run({ data: undefined });
  });
  return {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    addEventListener(type: "open" | "error" | "message" | "close", listener: Listener) {
      if (type === "error" || type === "close") failed.push(listener);
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

function refusingRoute(grants: string[]) {
  const refused: string[] = [];
  const relay = relayRoute({
    relayUrl: "wss://relay.invalid",
    hostId: "a".repeat(52),
    credential: async () => ({ grant: grants.shift() ?? "grant-x" }),
    socket: refusingSocket,
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
