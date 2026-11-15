import { afterEach, expect, it, vi } from "vitest";
import { NoiseNK, NoiseXX, keyPair } from "@ace/secure-channel";
import { connectPortableRelay, type PortableSocket } from "./portable-relay.ts";
import { RELAY_EARLY } from "./relay-early.ts";
import { relayRoute } from "./relay-route.ts";

// A relay dial that carries both an NK and an XX first message (ADR 0155, steps 2 and 3) makes
// two handshake states, each holding an ephemeral private key. Every way the dial ends erases
// both: the one not chosen as soon as the relay answers, and both on any failure.
//
// Erasure is the states' own `destroy` (it zeroes their keys); there is nothing else outside
// the state to observe, so these watch which states wrote a first message and which were
// destroyed.

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function watch() {
  const written = new Set<unknown>();
  const destroyed = new Set<unknown>();
  for (const type of [NoiseNK, NoiseXX]) {
    const write = vi.spyOn(type.prototype, "writeMessage");
    const destroy = vi.spyOn(type.prototype, "destroy");
    spies.push(write, destroy);
    write.mockImplementation(function (this: unknown, ...args: unknown[]) {
      written.add(this);
      return this instanceof NoiseXX
        ? originals.xxWrite.apply(this, args as [Uint8Array?])
        : originals.nkWrite.apply(this as NoiseNK, args as [Uint8Array?]);
    });
    destroy.mockImplementation(function (this: unknown) {
      destroyed.add(this);
      return this instanceof NoiseXX
        ? originals.xxDestroy.apply(this)
        : originals.nkDestroy.apply(this as NoiseNK);
    });
  }
  /** States that wrote a first message and were never destroyed. */
  const leaked = () => [...written].filter((state) => !destroyed.has(state));
  return { written, destroyed, leaked };
}
const originals = {
  xxWrite: NoiseXX.prototype.writeMessage,
  xxDestroy: NoiseXX.prototype.destroy,
  nkWrite: NoiseNK.prototype.writeMessage,
  nkDestroy: NoiseNK.prototype.destroy,
};

type Listener = (event?: { data?: unknown; code?: number; reason?: string }) => void;
/** A relay socket the test drives: `open(protocol)`, `close(code)`. */
function controlled() {
  const listeners = new Map<string, Listener[]>();
  let protocol = "";
  const fire = (type: string, event?: Parameters<Listener>[0]) => {
    for (const run of listeners.get(type) ?? []) run(event);
  };
  const socket: PortableSocket = {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    get protocol() {
      return protocol;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    send() {},
    close() {
      fire("close", { code: 1006 });
    },
  } as unknown as PortableSocket;
  return {
    socket,
    open(chosen: string) {
      protocol = chosen;
      fire("open");
    },
    close: (code = 1006) => fire("close", { code, reason: "" }),
  };
}

function dial(
  socket: PortableSocket,
  extra: { signal?: AbortSignal; timers?: (() => void)[] } = {},
) {
  return connectPortableRelay({
    relayUrl: "wss://relay.invalid",
    pinnedFingerprint: "A".repeat(52),
    socket: () => socket,
    keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
    schedule: (run) => {
      extra.timers?.push(run);
      return () => {};
    },
    early: true,
    inUpgrade: true,
    nk: {
      hostKey: keyPair().publicKey,
      early: new Uint8Array(200).fill(97),
      confirm: new Uint8Array(2),
    },
    ...(extra.signal ? { signal: extra.signal } : {}),
  });
}

it("a dial that fails before its socket opens erases both handshake states", async () => {
  const w = watch();
  const relay = controlled();
  const dialled = dial(relay.socket).catch(() => undefined);
  relay.close();
  await dialled;
  expect(w.written.size).toBe(2);
  expect(w.leaked()).toEqual([]);
});

it("a dial that times out erases both", async () => {
  const w = watch();
  const relay = controlled();
  const timers: (() => void)[] = [];
  const dialled = dial(relay.socket, { timers }).catch(() => undefined);
  for (const run of timers) run();
  await dialled;
  expect(w.leaked()).toEqual([]);
});

it("a cancelled dial erases both", async () => {
  const w = watch();
  const relay = controlled();
  const cancel = new AbortController();
  const dialled = dial(relay.socket, { signal: cancel.signal }).catch(() => undefined);
  cancel.abort();
  await dialled;
  expect(w.leaked()).toEqual([]);
});

it.each([
  ["NK's message", RELAY_EARLY.nkInUpgrade],
  ["XX's message", RELAY_EARLY.inUpgrade],
  ["neither", RELAY_EARLY.subprotocol],
])(
  "when the relay took %s, the state not chosen is erased at once, the other when the dial ends",
  async (_name, echo) => {
    const w = watch();
    const relay = controlled();
    const dialled = dial(relay.socket).catch(() => undefined);
    relay.open(echo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One of the two is gone before the handshake goes on.
    expect(w.written.size - w.leaked().length).toBe(1);
    relay.close();
    await dialled;
    expect(w.leaked()).toEqual([]);
  },
);

/** A route whose dial `n` behaves as `script(n)` says, and how many dials one attempt made. */
async function routeAttempt(script: (n: number, relay: ReturnType<typeof controlled>) => void) {
  let dials = 0;
  const route = relayRoute({
    relayUrl: "wss://relay.invalid",
    hostId: "A".repeat(52),
    credential: async () => ({ grant: "grant" }),
    socket: () => {
      const relay = controlled();
      const n = dials++;
      queueMicrotask(() => script(n, relay));
      return relay.socket;
    },
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  await new Promise<void>((resolve) =>
    route.transport().open({ open: () => {}, message: () => {}, close: () => resolve() }),
  );
  return dials;
}

it("the route's retry without the upgrade entries leaves no state unerased", async () => {
  const w = watch();
  const dials = await routeAttempt((n, relay) => {
    // Refused before opening, then a dial that opens and drops.
    if (n === 0) relay.close();
    else {
      relay.open(RELAY_EARLY.subprotocol);
      queueMicrotask(() => relay.close());
    }
  });
  expect(dials).toBe(2);
  expect(w.leaked()).toEqual([]);
});

it("the route's retry after a lost held frame leaves no state unerased", async () => {
  const w = watch();
  const dials = await routeAttempt((n, relay) => {
    relay.open(n === 0 ? RELAY_EARLY.inUpgrade : RELAY_EARLY.neutral);
    queueMicrotask(() => relay.close(n === 0 ? RELAY_EARLY.lostClose : 1006));
  });
  expect(dials).toBe(2);
  expect(w.leaked()).toEqual([]);
});
