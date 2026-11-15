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

// Step 3 (ADR 0155): the first handshake message in the upgrade request.

/** A relay socket that opens or fails before opening, echoing what `answer` picks. */
function scriptedOpen(answer: (offered: string[]) => string, opens: (n: number) => boolean) {
  const offered: string[][] = [];
  const socket = (_url: string, protocols?: string[]): PortableSocket => {
    const n = offered.push(protocols ?? []) - 1;
    const listeners = new Map<string, Listener[]>();
    const fire = (type: string, event: Parameters<Listener>[0] = { data: undefined }) => {
      for (const run of listeners.get(type) ?? []) run(event);
    };
    queueMicrotask(() => {
      if (opens(n)) fire("open");
      queueMicrotask(() => fire("close", { data: undefined, code: 1006, reason: "" }));
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

const carried = (offered: string[]) =>
  offered.filter((entry) => entry.startsWith(RELAY_EARLY.messagePrefix));

it("with a grant, a dial carries the first message in the upgrade beside what any relay echoes", async () => {
  const relay = scriptedOpen(
    (offered) => offered[0] ?? "",
    () => true,
  );
  await attempt(route(relay.socket, "grant-token"));
  const [offered = []] = relay.offered;
  expect(offered).toContain(RELAY_EARLY.inUpgrade);
  // XX's first message: 32 bytes, 43 characters of base64url.
  expect(carried(offered).map((entry) => entry.length)).toEqual([
    RELAY_EARLY.messagePrefix.length + 43,
  ]);
  expect(offered.some((entry) => entry.startsWith("ace.grant."))).toBe(true);
});

it("without a grant, a first dial offers nothing a relay could fail to echo, ace.v2 included", async () => {
  const relay = scriptedOpen(
    () => "",
    () => true,
  );
  await attempt(route(relay.socket));
  expect(relay.offered).toEqual([[]]);
});

it("an upgrade refused before opening with the message in it is retried once at once without it, and not offered again", async () => {
  // A proxy that refuses the larger header: the dial carrying the message never opens.
  const relay = scriptedOpen(
    (offered) => offered[0] ?? "",
    (n) => n !== 0,
  );
  const r = route(relay.socket, "grant-token");
  await attempt(r);
  expect(relay.offered).toHaveLength(2);
  expect(relay.offered[0]).toContain(RELAY_EARLY.inUpgrade);
  expect(relay.offered[1]).not.toContain(RELAY_EARLY.inUpgrade);
  expect(carried(relay.offered[1] ?? [])).toEqual([]);
  await attempt(r);
  expect(relay.offered[2]).not.toContain(RELAY_EARLY.inUpgrade);
});

it("when the dial without the message fails before opening too, the header wasn't why: it is offered again", async () => {
  const relay = scriptedOpen(
    (offered) => offered[0] ?? "",
    (n) => n >= 2,
  );
  const r = route(relay.socket, "grant-token");
  await attempt(r);
  expect(relay.offered).toHaveLength(2);
  await attempt(r);
  expect(relay.offered[2]).toContain(RELAY_EARLY.inUpgrade);
});
