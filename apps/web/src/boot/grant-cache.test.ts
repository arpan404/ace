import { Client, type Credential, type TransportEvents } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { grantCache, grantLifetimeCapMs, grantReuseMarginMs } from "./grant-cache.ts";

const lifeMs = 300_000;
/** Let the client's timers and promise chains run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * An account backend issuing five-minute grants, and a browser whose wall clock is `skewMs` off
 * the backend's (negative: behind). `elapsed` is the browser's forward-only clock.
 */
function backend(skewMs = 0) {
  let now = 0;
  let issued = 0;
  const asked: string[] = [];
  let failNext = false;
  /** The account backend can't be reached: every fetch fails as a network error does. */
  let down = false;
  /** How far the forward-only clock is behind: it stands still while the laptop sleeps. */
  let slept = 0;
  const cache = grantCache(
    async (session) => {
      asked.push(session);
      if (down) throw new TypeError("Failed to fetch");
      if (failNext) {
        failNext = false;
        throw new Error("backend down");
      }
      return { token: `grant-${++issued}`, expiresAt: now + lifeMs };
    },
    { wall: () => now + skewMs, elapsed: () => now - slept },
  );
  return {
    cache,
    asked,
    advance: (ms: number) => (now += ms),
    /** The laptop sleeps `ms`: the wall clock moves on, the forward-only clock does not. */
    sleep: (ms: number) => {
      now += ms;
      slept += ms;
    },
    failOnce: () => (failNext = true),
    setDown: (value: boolean) => (down = value),
  };
}

test("every path of a race shares one grant fetch", async () => {
  const b = backend();
  const s = "session";
  const tokens = await Promise.all([b.cache.grant(s), b.cache.grant(s), b.cache.grant(s)]);
  expect(tokens).toEqual(["grant-1", "grant-1", "grant-1"]);
  expect(b.asked).toEqual([s]);
});

test("a reconnect within the grant's life reuses it, and one near its end fetches anew", async () => {
  const b = backend();
  await b.cache.grant("s");
  b.advance(lifeMs - grantReuseMarginMs - 1);
  expect(await b.cache.grant("s")).toBe("grant-1");
  b.advance(2);
  expect(await b.cache.grant("s")).toBe("grant-2");
  expect(b.asked).toHaveLength(2);
});

test("another ace session never gets the last session's grant, and sign-out forgets it", async () => {
  const b = backend();
  expect(await b.cache.grant("a")).toBe("grant-1");
  expect(await b.cache.grant("b")).toBe("grant-2");
  b.cache.clear();
  expect(await b.cache.grant("b")).toBe("grant-3");
});

test("a failed fetch is not kept: the next connect asks again", async () => {
  const b = backend();
  b.failOnce();
  await expect(b.cache.grant("s")).rejects.toThrow("backend down");
  expect(await b.cache.grant("s")).toBe("grant-1");
});

test("a refused kept grant is dropped, and the next attempt fetches a new one", async () => {
  const b = backend();
  await b.cache.grant("s");
  // Offered again from the cache on a reconnect, then refused: worth one fresh try.
  expect(await b.cache.grant("s")).toBe("grant-1");
  expect(b.cache.refused("grant-1")).toBe(true);
  expect(await b.cache.grant("s")).toBe("grant-2");
  // Refused in the attempt it was fetched for: a fresh one would change nothing.
  expect(b.cache.refused("grant-2")).toBe(false);
  expect(await b.cache.grant("s")).toBe("grant-3");
});

test("a browser clock three minutes behind keeps a grant no longer than its real life", async () => {
  const b = backend(-180_000);
  await b.cache.grant("s");
  // The wall clock reads eight minutes left; the grant lives five from its fetch.
  b.advance(grantLifetimeCapMs - grantReuseMarginMs - 1);
  expect(await b.cache.grant("s")).toBe("grant-1");
  b.advance(2);
  expect(await b.cache.grant("s")).toBe("grant-2");
});

test("a clock three minutes behind never presents a refused grant a second time", async () => {
  const b = backend(-180_000);
  const hellos: string[] = [];
  let socket: TransportEvents | undefined;
  const client = new Client({
    deviceId: DeviceId.parse("browser"),
    transport: () => ({
      open(events) {
        socket = events;
        events.open();
      },
      send(text) {
        const message = JSON.parse(text) as { type: string; grant?: string };
        if (message.type === "hello" && message.grant) hellos.push(message.grant);
      },
      close() {},
    }),
    credential: async (): Promise<Credential> => ({ grant: await b.cache.grant("s") }),
    grantRefused: (grant) => b.cache.refused(grant),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0,
    id: () => "id",
    now: () => 0,
    limits: { retryBaseMs: 1, retryCapMs: 1 },
  });
  const deliver = (message: object) => socket?.message(JSON.stringify(message));
  const refuse = () => deliver({ type: "error", code: "unauthorized", message: "Expired" });
  const welcome = () =>
    deliver({
      type: "welcome",
      hostId: "6f1c2a8e-4b7d-4e2a-9c1f-2d3b4a5c6d7e",
      protocolVersion: 1,
      headSeq: 0,
    });
  await client.start();
  await settle();
  welcome();
  // A reconnect within the grant's local reuse window offers the kept grant again.
  b.advance(150_000);
  socket?.close(1006, "gone");
  await settle();
  expect(hellos).toEqual(["grant-1", "grant-1"]);
  // The daemon, on the right clock, finds it expired: dropped at once, retried with a fresh one.
  refuse();
  await settle();
  expect(hellos).toEqual(["grant-1", "grant-1", "grant-2"]);
  // A fresh grant refused too is final: no third try, and grant-1 never comes back.
  refuse();
  await settle();
  expect(client.state).toBe("fatal");
  expect(hellos).toEqual(["grant-1", "grant-1", "grant-2"]);
  await client.close();
});

/** An account machine's client on `b`'s cache, whose sockets each open and then wait. */
function machine(b: ReturnType<typeof backend>, name = "") {
  const sockets: TransportEvents[] = [];
  const client = new Client({
    deviceId: DeviceId.parse("browser"),
    transport: () => ({
      open(events) {
        sockets.push(events);
        events.open();
      },
      send() {},
      close() {},
    }),
    credential: async (): Promise<Credential> => ({ grant: await b.cache.grant("s", name) }),
    grantRefused: (grant) => b.cache.refused(grant, name),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const timer = setTimeout(run, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0,
    id: () => "id",
    now: () => 0,
    limits: { retryBaseMs: 5, retryCapMs: 5 },
  });
  const deliver = (message: object) => sockets.at(-1)?.message(JSON.stringify(message));
  return {
    client,
    last: () => sockets.at(-1),
    sockets,
    welcome: () =>
      deliver({
        type: "welcome",
        hostId: "6f1c2a8e-4b7d-4e2a-9c1f-2d3b4a5c6d7e",
        protocolVersion: 1,
        headSeq: 0,
      }),
    refuse: () => deliver({ type: "error", code: "unauthorized", message: "Expired" }),
  };
}

test("five drops before the welcome on a healthy grant fetch it once, not five times", async () => {
  const b = backend();
  const m = machine(b);
  await m.client.start();
  await settle();
  // A flaky link: every socket drops after its hello, before the welcome.
  for (let drop = 0; drop < 5; drop++) {
    m.last()?.close(1006, "gone");
    await settle();
  }
  expect(m.sockets.length).toBeGreaterThanOrEqual(6);
  expect(b.asked.length).toBeLessThanOrEqual(2);
  await m.client.close();
});

test("a drop on one machine never evicts the grant another machine just fetched", async () => {
  const b = backend();
  const a = machine(b);
  await a.client.start();
  await settle();
  const fetched = b.asked.length;
  const other = machine(b);
  await other.client.start();
  await settle();
  // Machine A drops before its welcome; machine B's next connect still finds the kept grant.
  a.last()?.close(1006, "gone");
  await settle();
  other.last()?.close(1006, "gone");
  await settle();
  expect(b.asked.length).toBe(fetched);
  await a.client.close();
  await other.client.close();
});

test("a refusal of a grant that is no longer the kept one evicts nothing", async () => {
  const b = backend();
  await b.cache.grant("s");
  expect(b.cache.refused("grant-0")).toBe(false);
  expect(await b.cache.grant("s")).toBe("grant-1");
  expect(b.asked).toHaveLength(1);
});

test("two machines sharing one expired cached grant both recover, with one fresh fetch", async () => {
  const b = backend();
  // Machine A fetched the grant; later both reconnect and take it from the cache.
  await b.cache.grant("s", "machine-a");
  await b.cache.grant("s", "machine-a");
  await b.cache.grant("s", "machine-b");
  // The daemon finds it expired on both: each refusal, in either order, earns a retry.
  expect(b.cache.refused("grant-1", "machine-a")).toBe(true);
  expect(b.cache.refused("grant-1", "machine-b")).toBe(true);
  // Both retries share one fresh fetch.
  const retries = await Promise.all([
    b.cache.grant("s", "machine-a"),
    b.cache.grant("s", "machine-b"),
  ]);
  expect(retries).toEqual(["grant-2", "grant-2"]);
  expect(b.asked).toHaveLength(2);
});

test("a grant fetched fresh for an attempt and refused is final, beside one served cached", async () => {
  const b = backend();
  // Machine A's attempt fetched it; machine B's took it from the cache.
  await b.cache.grant("s", "machine-a");
  await b.cache.grant("s", "machine-b");
  // B's refusal first, then A's: B retries, A's is final.
  expect(b.cache.refused("grant-1", "machine-b")).toBe(true);
  expect(b.cache.refused("grant-1", "machine-a")).toBe(false);
});

test("after the laptop sleeps ten minutes, the kept grant is not offered", async () => {
  const b = backend();
  await b.cache.grant("s");
  b.sleep(600_000);
  expect(await b.cache.grant("s")).toBe("grant-2");
});

test("the backend down during the shared retry fetch, then back: both machines reconnect", async () => {
  const b = backend();
  const a = machine(b, "machine-a");
  const other = machine(b, "machine-b");
  await a.client.start();
  await settle();
  a.welcome();
  await other.client.start();
  await settle();
  other.welcome();
  // Both drop and reconnect, each saying hello with the kept grant from the cache.
  a.last()?.close(1006, "gone");
  other.last()?.close(1006, "gone");
  await settle();
  // The daemon finds the shared grant expired; the backend can't be reached for a fresh one.
  b.setDown(true);
  a.refuse();
  other.refuse();
  await settle();
  // Failing to get a grant is no refusal of one: both keep trying, neither stops.
  expect(a.client.state).not.toBe("fatal");
  expect(other.client.state).not.toBe("fatal");
  b.setDown(false);
  await settle();
  a.welcome();
  other.welcome();
  expect(a.client.state).toBe("ready");
  expect(other.client.state).toBe("ready");
  await a.client.close();
  await other.client.close();
});

test("a first connect with the backend down connects on its own once it is back", async () => {
  const b = backend();
  b.setDown(true);
  const m = machine(b, "machine-a");
  await m.client.start();
  await settle();
  expect(m.client.state).not.toBe("fatal");
  b.setDown(false);
  await settle();
  m.welcome();
  expect(m.client.state).toBe("ready");
  await m.client.close();
});

test("an account switch leaves no record of how the old account's grants were given", async () => {
  const b = backend();
  await b.cache.grant("old-session", "machine-a");
  await b.cache.grant("old-session", "machine-a");
  // Another account signs in on this window and opens a machine.
  await b.cache.grant("new-session", "machine-b");
  // A late refusal of the old account's grant earns nothing: its record is gone.
  expect(b.cache.refused("grant-1", "machine-a")).toBe(false);
});

test("a machine welcomed, closed or removed leaves no record behind", async () => {
  const b = backend();
  const machines = ["machine-a", "machine-b", "machine-c"];
  for (const name of machines) {
    await b.cache.grant("s", name);
    await b.cache.grant("s", name);
    b.cache.settled(name);
  }
  for (const name of machines) expect(b.cache.refused("grant-1", name)).toBe(false);
});

test("a kept grant's standing grant is found by the grant, and a sign-out forgets it", async () => {
  let issued = 0;
  const cache = grantCache(
    async () => {
      issued++;
      return { token: `grant-${issued}`, expiresAt: lifeMs, standing: `standing-${issued}` };
    },
    { wall: () => 0, elapsed: () => 0 },
  );
  const first = await cache.grant("session", "machine-a");
  // Another machine shares the kept grant, and its hello finds the same standing grant.
  expect(await cache.grant("session", "machine-b")).toBe(first);
  expect(cache.standing(first)).toBe("standing-1");
  expect(cache.standing("grant-other")).toBeUndefined();
  cache.clear();
  expect(cache.standing(first)).toBeUndefined();
});
