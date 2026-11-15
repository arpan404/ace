import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { CONTROL, Offer, Registration, address, initiate, json, peer } from "@ace/relay/testing";
import { EARLY_FRAME, NK_UPGRADE_MESSAGE, UPGRADE_MESSAGE } from "@ace/relay/wire";
import { WebSocket } from "ws";
import { mint, startWorker } from "./testing/harness.ts";

// ace cloud's relay taking a client's first message from its upgrade request (ADR 0155, step 3),
// in real workerd: taken only with room reserved, held as step 1's early frame (in memory, its
// state in the socket attachment), delivered once and first, and lost to an eviction only as
// step 1's frame is.

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

const grant = () => GRANT_SUBPROTOCOL_PREFIX + mint("device", "user_a", "phone");

async function openPeer(url: string, protocols: string[] = []) {
  const options = { maxPayload: 65535, perMessageDeflate: false, closeTimeout: 500 };
  const socket = new WebSocket(url, protocols, options);
  const connection = peer(socket);
  const ending = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cleanups.push(() => connection.close());
  return { ...connection, ending };
}

/** A daemon registered by hand, so the test decides when it joins a ticket. */
async function rawDaemon() {
  const keys = keyPair();
  const id = hostId(keys.publicKey);
  const control = await openPeer(address(worker.relayUrl, "/host", { hostId: id }), [
    GRANT_SUBPROTOCOL_PREFIX + mint("machine", "user_a", id),
  ]);
  const transport = await initiate(control, CONTROL, keys);
  Registration.parse(json(transport.receive.decrypt(await control.next())));
  return {
    id,
    async offer() {
      return Offer.parse(json(transport.receive.decrypt(await control.next()))).ticket;
    },
    /** A client that may send early, offering `message` in its upgrade. */
    client: (message?: Uint8Array) =>
      openPeer(address(worker.relayUrl, "/client", { hostId: id, [EARLY_FRAME.query]: "1" }), [
        grant(),
        ...(message
          ? [
              UPGRADE_MESSAGE.subprotocol,
              UPGRADE_MESSAGE.prefix + Buffer.from(message).toString("base64url"),
            ]
          : []),
        EARLY_FRAME.subprotocol,
      ]),
    join: (ticket: string) => openPeer(address(worker.relayUrl, "/join", { ticket, hostId: id })),
  };
}

async function within(next: Promise<Buffer>, ms = 300): Promise<Buffer | undefined> {
  return Promise.race([
    next,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

const first = new Uint8Array(32).map((_, i) => i + 1);

it("a first message in the upgrade is taken, echoed, and delivered to the joining daemon once and first", async () => {
  const host = await rawDaemon();
  const client = await host.client(first);
  expect(client.socket.protocol).toBe(UPGRADE_MESSAGE.subprotocol);
  const joined = await host.join(await host.offer());
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([...first]);
  await client.send(new Uint8Array([4]));
  expect([...(await joined.next())]).toEqual([4]);
  expect(await within(joined.next())).toBeUndefined();
}, 15_000);

it("a client that also sends the message as a frame before pairing is closed: it is delivered once", async () => {
  const host = await rawDaemon();
  const client = await host.client(first);
  await client.send(first);
  expect((await client.ending).code).toBe(1008);
}, 15_000);

it("with every early reservation taken, the entry is left unread and the grant echoed as before", async () => {
  const host = await rawDaemon();
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) await host.client();
  const late = await host.client(first);
  expect(late.socket.protocol.startsWith(GRANT_SUBPROTOCOL_PREFIX)).toBe(true);
}, 30_000);

it("an object asleep when the upgrade arrives wakes, takes the message and delivers it", async () => {
  const host = await rawDaemon();
  await worker.hibernate(host.id);
  const client = await host.client(first);
  expect(client.socket.protocol).toBe(UPGRADE_MESSAGE.subprotocol);
  const joined = await host.join(await host.offer());
  expect([...(await joined.next())]).toEqual([...first]);
}, 15_000);

it("evicted after it took the message, the object closes the client so it connects again without it", async () => {
  const host = await rawDaemon();
  const client = await host.client(first);
  const ticket = await host.offer();
  await worker.hibernate(host.id);
  await host.join(ticket).catch(() => undefined);
  expect(await client.ending).toEqual({ code: EARLY_FRAME.lostClose, reason: "Early frame lost" });
  // Its room was given back, and a client that sends early is taken again.
  expect((await host.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
}, 15_000);

it("an older client that offers no upgrade message gets step 1 as before", async () => {
  const host = await rawDaemon();
  const client = await host.client();
  expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
}, 15_000);

it.each([
  ["1 byte", new Uint8Array(1)],
  ["31 bytes", new Uint8Array(31)],
  ["33 bytes", new Uint8Array(33)],
])(
  "an entry of %s isn't taken: the client may send early, as step 1 lets it",
  async (_name, bytes) => {
    const host = await rawDaemon();
    const client = await host.client(bytes);
    expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
    // Nothing was held for it: a frame it sends is its early frame.
    await client.send(new Uint8Array([5]));
    const joined = await host.join(await host.offer());
    expect([...(await joined.next())]).toEqual([5]);
  },
  15_000,
);

// With step 2: an NK first message under its own entry.

const nkFirst = new Uint8Array(400).map((_, i) => (i * 7) % 256);
const nkClient = (id: string) =>
  openPeer(address(worker.relayUrl, "/client", { hostId: id, [EARLY_FRAME.query]: "1" }), [
    grant(),
    NK_UPGRADE_MESSAGE.subprotocol,
    NK_UPGRADE_MESSAGE.prefix + Buffer.from(nkFirst).toString("base64url"),
    UPGRADE_MESSAGE.subprotocol,
    UPGRADE_MESSAGE.prefix + Buffer.from(first).toString("base64url"),
    EARLY_FRAME.subprotocol,
  ]);

it("an NK first message in the upgrade is taken ahead of XX's, echoed ace.v3, and delivered once", async () => {
  const host = await rawDaemon();
  const client = await nkClient(host.id);
  expect(client.socket.protocol).toBe(NK_UPGRADE_MESSAGE.subprotocol);
  const joined = await host.join(await host.offer());
  expect([...(await joined.next())]).toEqual([...nkFirst]);
  expect(await within(joined.next())).toBeUndefined();
}, 15_000);

it("evicted after it took an NK message, the object closes the client with the lost-frame code", async () => {
  const host = await rawDaemon();
  const client = await nkClient(host.id);
  const ticket = await host.offer();
  await worker.hibernate(host.id);
  await host.join(ticket).catch(() => undefined);
  expect(await client.ending).toEqual({ code: EARLY_FRAME.lostClose, reason: "Early frame lost" });
}, 15_000);
