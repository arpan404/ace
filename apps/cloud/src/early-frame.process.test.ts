import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { CONTROL, Offer, Registration, address, initiate, json, peer } from "@ace/relay/testing";
import { EARLY_FRAME, PAIRED_MARKER } from "@ace/relay/wire";
import { WebSocket } from "ws";
import { mint, startWorker } from "./testing/harness.ts";

// ace cloud's relay holding one early client frame (ADR 0155, step 1), in real workerd: the
// frame is held in the object's memory, its state in the socket attachment, and the harness
// evicts the object the way the runtime does.

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
    client: (early = true) =>
      openPeer(
        address(worker.relayUrl, "/client", {
          hostId: id,
          ...(early ? { [EARLY_FRAME.query]: "1" } : {}),
        }),
        early ? [grant(), EARLY_FRAME.subprotocol] : [grant()],
      ),
    join: (ticket: string) => openPeer(address(worker.relayUrl, "/join", { ticket, hostId: id })),
  };
}

async function within(next: Promise<Buffer>, ms = 300): Promise<Buffer | undefined> {
  return Promise.race([
    next,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

it("a client told it may send early is delivered once its daemon joins, in order and once", async () => {
  const host = await rawDaemon();
  const client = await host.client();
  expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
  await client.send(new Uint8Array([1, 2, 3]));
  const joined = await host.join(await host.offer());
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([1, 2, 3]);
  await client.send(new Uint8Array([4]));
  expect([...(await joined.next())]).toEqual([4]);
  expect(await within(joined.next())).toBeUndefined();
}, 15_000);

it("an older client is answered with its grant and closed for sending before it is paired", async () => {
  const host = await rawDaemon();
  const old = await host.client(false);
  expect(old.socket.protocol.startsWith(GRANT_SUBPROTOCOL_PREFIX)).toBe(true);
  await old.send(new Uint8Array([1]));
  expect((await old.ending).code).toBe(1008);
}, 15_000);

it("an older client gets the marker it knows", async () => {
  const host = await rawDaemon();
  const old = await host.client(false);
  await host.join(await host.offer());
  expect([...(await old.next())]).toEqual([PAIRED_MARKER]);
}, 15_000);

it("with every early reservation for the daemon taken, a client gets its grant back and connects as before", async () => {
  const host = await rawDaemon();
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++)
    expect((await host.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
  const late = await host.client();
  expect(late.socket.protocol.startsWith(GRANT_SUBPROTOCOL_PREFIX)).toBe(true);
}, 30_000);

it("evicted before the frame arrives, the reservation survives and the frame is held after waking", async () => {
  const host = await rawDaemon();
  const client = await host.client();
  expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
  const ticket = await host.offer();
  await worker.hibernate(host.id);
  await client.send(new Uint8Array([7, 7]));
  const joined = await host.join(ticket);
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect([...(await joined.next())]).toEqual([7, 7]);
}, 15_000);

it("evicted after the frame arrives, the client is closed so it can connect again without sending early", async () => {
  const host = await rawDaemon();
  const client = await host.client();
  await client.send(new Uint8Array([7, 7]));
  const ticket = await host.offer();
  // Give the frame time to reach the object before it is evicted.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await worker.hibernate(host.id);
  // The daemon's join wakes the object, which finds the frame gone.
  await host.join(ticket).catch(() => undefined);
  expect(await client.ending).toEqual({ code: EARLY_FRAME.lostClose, reason: "Early frame lost" });
  // Its reservation was given back: a new client is told it may send early.
  expect((await host.client()).socket.protocol).toBe(EARLY_FRAME.subprotocol);
}, 15_000);

it("16 clients that each send two frames and never answer the close free their room at once", async () => {
  const host = await rawDaemon();
  const frame = new Uint8Array(EARLY_FRAME.frameBytes).fill(7);
  const clients = [];
  for (let n = 0; n < EARLY_FRAME.hostFrames; n++) {
    const client = await host.client();
    expect(client.socket.protocol).toBe(EARLY_FRAME.subprotocol);
    await client.send(frame);
    await client.send(frame);
    // It reads nothing more: the relay's close is never answered.
    client.socket.pause();
    clients.push(client);
  }
  // Each second frame turned its client away; the object freed the held frame and the room as
  // it did, without waiting for an answer, so new clients are let in at once.
  let admitted = false;
  const started = Date.now();
  while (!admitted && Date.now() - started < 3_000) {
    admitted = (await host.client()).socket.protocol === EARLY_FRAME.subprotocol;
    if (!admitted) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(admitted).toBe(true);
  // None of their frames reaches a daemon that joins one of their tickets: the join is refused
  // or hears nothing.
  const joined = await host.join(await host.offer());
  expect(await within(joined.next().catch(() => Buffer.alloc(0)))).toSatisfy(
    (heard: Buffer | undefined) => heard === undefined || heard.length === 0,
  );
}, 30_000);
