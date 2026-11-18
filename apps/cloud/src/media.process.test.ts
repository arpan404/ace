import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { hostId, keyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import { PAIRED_MARKER } from "@ace/relay/wire";
import { address, deferred } from "@ace/relay/testing";
import { WebSocket } from "ws";
import { mint, startWorker } from "./testing/harness.ts";

// The `media` purpose on ace's hosted relay (ADR 0147 §5.2): a media client is offered only to
// a daemon that registered with the `media` feature, through hibernation too, and the daemon
// joins that ticket from wherever it chooses (ace-media dials it).

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

async function daemon(media: boolean, aceClient?: string) {
  const hostKeys = keyPair();
  const offers: { ticket: string; joinUrl: string }[] = [];
  let next = deferred<string>();
  const connection = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account: { grant: async () => mint("machine", "user_a", hostId(hostKeys.publicKey)) },
    onClientChannel: (channel) => channel.close(),
    ...(aceClient ? { aceClient } : {}),
    ...(media
      ? {
          media: {
            offer(ticket: string, joinUrl: string) {
              offers.push({ ticket, joinUrl });
              next.resolve(joinUrl);
              return true;
            },
          },
        }
      : {}),
  });
  cleanups.push(() => connection.close());
  return {
    connection,
    offers,
    nextOffer() {
      next = deferred<string>();
      return next.promise;
    },
  };
}

function open(url: string, protocols: string[]) {
  // ws reads `closeTimeout`; its type definitions don't list it yet.
  const options = { perMessageDeflate: false, closeTimeout: 500 };
  const socket = new WebSocket(url, protocols, options);
  cleanups.push(() => socket.terminate());
  const frames: Buffer[] = [];
  const arrived = deferred<void>();
  socket.on("message", (data: Buffer) => {
    frames.push(data);
    arrived.resolve();
  });
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, frames, arrived: arrived.promise, closed, opened };
}

const device = () => [GRANT_SUBPROTOCOL_PREFIX + mint("device", "user_a", "phone")];

it("a media client meets the stream its daemon joins, before and after hibernation", async () => {
  // Named, as the daemon is: ace-media's own upgrade carries the name on the join address.
  const host = await daemon(true, "daemon/0.0.24-beta.1");
  for (const round of [0, 1]) {
    if (round === 1) await worker.hibernate(host.connection.hostId);
    const offered = host.nextOffer();
    const client = open(
      address(worker.relayUrl, "/client", { hostId: host.connection.hostId, purpose: "media" }),
      device(),
    );
    await client.opened;
    const joinUrl = await offered;
    expect(new URL(joinUrl).pathname).toBe("/join");
    expect(new URL(joinUrl).searchParams.get("ace-client")).toBe("daemon/0.0.24-beta.1");
    // The daemon's media process dials the join address; the relay then pairs the two.
    const joined = open(joinUrl, []);
    await joined.opened;
    await client.arrived;
    expect([...(client.frames[0] ?? [])]).toEqual([PAIRED_MARKER]);
    joined.socket.send(new Uint8Array([9, 9]));
    await expect.poll(() => client.frames.length).toBe(2);
  }
  expect(host.offers).toHaveLength(2);
});

it("a daemon without the media feature is never offered a media client", async () => {
  const host = await daemon(false);
  await expect(
    connectClientViaRelay({
      relayUrl: worker.relayUrl,
      hostId: host.connection.hostId,
      pinnedFingerprint: host.connection.hostId,
      grant: mint("device", "user_a", "phone"),
      purpose: "media",
    }),
  ).rejects.toThrow();
  // Its registration survives: an older daemon would have dropped the session on the offer.
  expect(host.connection.generation).toBe(1);
});

it("a client naming a purpose the relay doesn't know is refused", async () => {
  const host = await daemon(true);
  const client = open(
    address(worker.relayUrl, "/client", { hostId: host.connection.hostId, purpose: "files" }),
    device(),
  );
  await client.opened.catch(() => {});
  expect(await client.closed).toBe(1008);
  expect(host.offers).toHaveLength(0);
});
