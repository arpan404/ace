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
  const cache = grantCache(
    async (session) => {
      asked.push(session);
      if (failNext) {
        failNext = false;
        throw new Error("backend down");
      }
      return { token: `grant-${++issued}`, expiresAt: now + lifeMs };
    },
    { wall: () => now + skewMs, elapsed: () => now },
  );
  return {
    cache,
    asked,
    advance: (ms: number) => (now += ms),
    failOnce: () => (failNext = true),
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
function machine(b: ReturnType<typeof backend>) {
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
  return { client, last: () => sockets.at(-1), sockets };
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
