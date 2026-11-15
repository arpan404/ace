import { expect, it } from "vitest";
import type { PortableSocket } from "./portable-relay.ts";
import { RELAY_EARLY, relayRoute } from "./relay-route.ts";

// What the relay route offers on each dial (ADR 0155, step 1): the early subprotocol only when
// the relay is sure to answer one it was offered, and once without it after the hosted relay
// lost a held frame.

type Listener = (event: { data: unknown; code?: number; reason?: string }) => void;

/** A relay socket that opens, echoes what `answer` picks, then closes with `code`. */
function scripted(answer: (offered: string[]) => string, code: number) {
  const offered: string[][] = [];
  const socket = (_url: string, protocols?: string[]): PortableSocket => {
    offered.push(protocols ?? []);
    const listeners = new Map<string, Listener[]>();
    const fire = (type: string, event: Parameters<Listener>[0] = { data: undefined }) => {
      for (const run of listeners.get(type) ?? []) run(event);
    };
    queueMicrotask(() => {
      fire("open");
      queueMicrotask(() => fire("close", { data: undefined, code, reason: "" }));
    });
    return {
      binaryType: "arraybuffer",
      bufferedAmount: 0,
      protocol: answer(protocols ?? []),
      addEventListener(type: "open" | "error" | "message" | "close", listener: Listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send() {},
      close() {},
    };
  };
  return { socket, offered };
}

function attempt(route: ReturnType<typeof relayRoute>): Promise<number> {
  return new Promise((resolve) =>
    route.transport().open({ open: () => {}, message: () => {}, close: (code) => resolve(code) }),
  );
}

const route = (socket: (url: string, protocols?: string[]) => PortableSocket, grant?: string) =>
  relayRoute({
    relayUrl: "wss://relay.invalid",
    hostId: "A".repeat(52),
    credential: async () => (grant ? { grant } : { token: "device token" }),
    socket,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });

it("with a grant, a dial offers to send early: an older relay still has the grant to echo", async () => {
  const relay = scripted((offered) => offered[0] ?? "", 1006);
  await attempt(route(relay.socket, "grant-token"));
  expect(relay.offered[0]).toContain(RELAY_EARLY.subprotocol);
});

it("without a grant, a first dial offers nothing an older relay could fail to echo", async () => {
  const relay = scripted(() => "", 1006);
  await attempt(route(relay.socket));
  expect(relay.offered).toEqual([[]]);
});

it("a held frame the relay lost is followed by one immediate dial that doesn't send early", async () => {
  const relay = scripted(
    (offered) =>
      offered.includes(RELAY_EARLY.subprotocol) ? RELAY_EARLY.subprotocol : (offered[0] ?? ""),
    RELAY_EARLY.lostClose,
  );
  const code = await attempt(route(relay.socket, "grant-token"));
  expect(relay.offered).toHaveLength(2);
  expect(relay.offered[0]).toContain(RELAY_EARLY.subprotocol);
  expect(relay.offered[1]).not.toContain(RELAY_EARLY.subprotocol);
  // The second loss isn't retried again: the attempt ends, and reconnects as after any drop.
  expect(code).toBe(1006);
});
