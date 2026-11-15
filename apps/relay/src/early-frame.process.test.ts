import { afterEach, expect, it } from "vitest";
import { keyPair } from "@ace/secure-channel";
import { startRelay } from "./server.ts";
import { EARLY_FRAME, PAIRED_MARKER } from "./wire.ts";
import { Offer, address, json, openPeer, register } from "./testing/peer.ts";

// The self-hosted relay holding one early client frame (ADR 0155, step 1), over real sockets:
// a client that the relay let send early is delivered once its host joins, and everything else
// behaves as before.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function relayWithHost(limits: { ticketTimeoutMs?: number } = {}) {
  const relay = await startRelay({ limits });
  cleanups.push(() => relay.close());
  const keys = keyPair();
  const daemon = await register(relay.url, keys);
  cleanups.push(() => daemon.close());
  const offer = async () =>
    Offer.parse(json(daemon.transport.receive.decrypt(await daemon.next()))).ticket;
  const client = async (early = true) => {
    const opened = await openPeer(
      address(relay.url, "/client", {
        hostId: daemon.hostId,
        ...(early ? { [EARLY_FRAME.query]: "1" } : {}),
      }),
      // A new client without a grant offers the neutral one too, so a relay with no room
      // still has one to echo.
      early ? [EARLY_FRAME.subprotocol, EARLY_FRAME.neutral] : [],
    );
    cleanups.push(() => opened.close());
    return opened;
  };
  const join = async (ticket: string) => {
    const joined = await openPeer(address(relay.url, "/join", { ticket }));
    cleanups.push(() => joined.close());
    return joined;
  };
  return { relay, keys, daemon, offer, client, join };
}

/** The next frame, or undefined when none comes within `ms`. */
async function within(next: Promise<Buffer>, ms = 300): Promise<Buffer | undefined> {
  return Promise.race([
    next,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

it("a client the relay let send early is delivered once its host joins, in order and once", async () => {
  const h = await relayWithHost();
  const client = await h.client();
  // The upgrade answer itself says the client may send now.
  expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
  await client.send(new Uint8Array([1, 2, 3]));
  const joined = await h.join(await h.offer());
  // The marker also tells a new client this relay holds early frames.
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([1, 2, 3]);
  await client.send(new Uint8Array([4]));
  expect([...(await joined.next())]).toEqual([4]);
  // Exactly once: nothing else arrives, and the stream runs both ways.
  expect(await within(joined.next())).toBeUndefined();
  await joined.send(new Uint8Array([9]));
  expect([...(await client.next())]).toEqual([9]);
});

it("with every early reservation for a host taken, a client is not told it may send early and connects as before", async () => {
  const h = await relayWithHost();
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) {
    expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
    expect(h.relay.earlyHeld()).toMatchObject({ reserved: n + 1, frames: 0, queuedBytes: 0 });
  }
  const late = await h.client();
  expect(h.relay.earlyHeld().reserved).toBe(EARLY_FRAME.hostFrames);
  expect(late.socket.protocol).toBe(EARLY_FRAME.neutral);
  // Today's path: wait for the marker, then send.
  for (let n = 0; n <= EARLY_FRAME.hostFrames; n++) await h.offer();
  expect(late.socket.readyState).toBe(late.socket.OPEN);
});

it("a client that wasn't told it may send early is still closed for sending before it is paired", async () => {
  const h = await relayWithHost();
  const old = await h.client(false);
  expect(old.socket.protocol).toBe("");
  await old.send(new Uint8Array([1]));
  expect(await old.closed).toBe(1008);
});

it("a second frame before pairing closes the early sender", async () => {
  const h = await relayWithHost();
  const client = await h.client();
  await client.send(new Uint8Array([1]));
  await client.send(new Uint8Array([2]));
  expect(await client.closed).toBe(1008);
});

it("expiry, a newer registration and a client's own disconnect each free their reservation", async () => {
  const h = await relayWithHost({ ticketTimeoutMs: 200 });
  const fill = async () => {
    const clients = [];
    for (let n = 0; n < EARLY_FRAME.hostFrames; n++) clients.push(await h.client());
    for (const client of clients) expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
    expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.neutral);
    return clients;
  };
  const expiring = await fill();
  expect(h.relay.earlyHeld().reserved).toBe(EARLY_FRAME.hostFrames);
  await new Promise((resolve) => setTimeout(resolve, 250));
  h.relay.sweep();
  for (const client of expiring) expect(await client.closed).toBe(1008);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.relay.earlyHeld()).toMatchObject({ reserved: 0, frames: 0, queuedBytes: 0 });
  // Freed by expiry: the next ones are told they may send early again.
  const replaced = await fill();
  const again = await register(h.relay.url, h.keys);
  cleanups.push(() => again.close());
  for (const client of replaced) expect(await client.closed).toBe(1008);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(h.relay.earlyHeld().reserved).toBe(0);
  const leaving = [];
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) leaving.push(await h.client());
  leaving[0]?.close();
  await leaving[0]?.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
});

it("nothing is held for clients of a host that isn't registered", async () => {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const stranger = await register(relay.url);
  stranger.close();
  await stranger.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const flood = [];
  for (let n = 0; n < 20; n++) {
    const opened = await openPeer(address(relay.url, "/client", { hostId: stranger.hostId }), [
      EARLY_FRAME.subprotocol,
      EARLY_FRAME.neutral,
    ]);
    cleanups.push(() => opened.close());
    flood.push(opened);
  }
  for (const opened of flood) {
    expect(opened.socket.protocol).toBe(EARLY_FRAME.neutral);
    expect(await opened.closed).toBe(1008);
  }
});

it("an older client that didn't ask gets the marker it knows; a new one learns the relay holds early frames", async () => {
  const h = await relayWithHost();
  const old = await h.client(false);
  await h.join(await h.offer());
  expect([...(await old.next())]).toEqual([PAIRED_MARKER]);
  const learning = await openPeer(
    address(h.relay.url, "/client", { hostId: h.daemon.hostId, [EARLY_FRAME.query]: "1" }),
  );
  cleanups.push(() => learning.close());
  await h.join(await h.offer());
  expect([...(await learning.next())]).toEqual([EARLY_FRAME.capableMarker]);
});

it("16 clients that each send two full frames and never answer the close hold at most 1 MiB", async () => {
  const h = await relayWithHost({ ticketTimeoutMs: 300 });
  const frame = new Uint8Array(EARLY_FRAME.frameBytes).fill(7);
  let peak = 0;
  let peakQueued = 0;
  const watch = setInterval(() => {
    const held = h.relay.earlyHeld();
    peak = Math.max(peak, held.bytes);
    peakQueued = Math.max(peakQueued, held.queuedBytes);
  }, 5);
  cleanups.push(() => clearInterval(watch));
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) {
    const client = await h.client();
    expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
    await client.send(frame);
    await client.send(frame);
    // It reads nothing more: the relay's close is never answered.
    client.socket.pause();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(h.relay.earlyHeld().reserved).toBe(EARLY_FRAME.hostFrames);
  // No room while their bytes may still be held.
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.neutral);
  // Expiry turns them away; the relay cuts each socket within its deadline, unanswered.
  await new Promise((resolve) => setTimeout(resolve, 300));
  h.relay.sweep();
  const started = Date.now();
  while (h.relay.earlyHeld().reserved > 0 && Date.now() - started < 3_000)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(Date.now() - started).toBeLessThan(1_500);
  expect(h.relay.earlyHeld()).toEqual({ reserved: 0, frames: 0, bytes: 0, queuedBytes: 0 });
  expect(peak).toBeLessThanOrEqual(EARLY_FRAME.hostBytes);
  expect(peakQueued).toBeLessThanOrEqual(EARLY_FRAME.hostBytes);
  // Room came back only once the sockets were gone.
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
});

/** 16 early clients the relay turns away for `misbehave`, each reading nothing after. */
async function turnedAway(
  misbehave: (client: Awaited<ReturnType<typeof openPeer>>) => unknown,
  query: Record<string, string> = {},
) {
  const h = await relayWithHost();
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) {
    const client = await openPeer(
      address(h.relay.url, "/client", {
        hostId: h.daemon.hostId,
        [EARLY_FRAME.query]: "1",
        ...query,
      }),
      [EARLY_FRAME.subprotocol, EARLY_FRAME.neutral],
    );
    cleanups.push(() => client.close());
    await misbehave(client);
    // It never answers the relay's close.
    client.socket.pause();
  }
  return h;
}

/** Waits until the host's early room is all free again, and how long that took. */
async function freed(h: Awaited<ReturnType<typeof relayWithHost>>): Promise<number> {
  const started = Date.now();
  while (h.relay.earlyHeld().reserved > 0 && Date.now() - started < 5_000)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.relay.earlyHeld()).toEqual({ reserved: 0, frames: 0, bytes: 0, queuedBytes: 0 });
  return Date.now() - started;
}

it("clients asking for an unknown purpose hold no early room, even when they never answer the close", async () => {
  const h = await turnedAway(() => {}, { purpose: "bogus" });
  expect(await freed(h)).toBeLessThan(1_500);
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
});

it("clients turned away for a text frame give their room back within the deadline, unanswered", async () => {
  const h = await turnedAway((client) => client.socket.send("not binary"));
  expect(await freed(h)).toBeLessThan(1_500);
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
});

it("clients turned away for an oversized message give their room back within the deadline, unanswered", async () => {
  const h = await turnedAway((client) => client.send(new Uint8Array(EARLY_FRAME.frameBytes + 1)));
  expect(await freed(h)).toBeLessThan(1_500);
  expect((await h.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
});
