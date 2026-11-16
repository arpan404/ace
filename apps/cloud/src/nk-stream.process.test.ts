import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { connectHostToRelay, type HostChannel, type NkHost } from "@ace/relay";
import { address, initiate, peer, STREAM } from "@ace/relay/testing";
import { EARLY_FRAME, NK_STREAM_PROLOGUE } from "@ace/relay/wire";
import { NoiseNK, hostId, keyPair } from "@ace/secure-channel";
import { WebSocket } from "ws";
import { mint, startWorker } from "./testing/harness.ts";

// ace cloud's relay carrying a stream opened with Noise NK (ADR 0155, step 2), in real workerd:
// the first message held early or sent after the marker, the daemon's answer, a refusal, and
// XX beside it unchanged. The relay forwards ciphertext and reads none of it.

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

const deviceGrant = () => GRANT_SUBPROTOCOL_PREFIX + mint("device", "user_a", "phone");

async function openPeer(url: string, protocols: string[]) {
  const socket = new WebSocket(url, protocols, { maxPayload: 65535, perMessageDeflate: false });
  const connection = peer(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cleanups.push(() => connection.close());
  return { ...connection, protocol: socket.protocol };
}

/** A daemon's relay host that admits an NK first message reading `admit`, and echoes. */
async function daemon(admit: (early: string) => boolean) {
  const keys = keyPair();
  const id = hostId(keys.publicKey);
  const arrived: HostChannel[] = [];
  const nk: NkHost = {
    arrive: () => true,
    async admit(payload) {
      if (!admit(new TextDecoder().decode(payload))) return undefined;
      return {
        abandon: () => {},
        async open(channel) {
          arrived.push(channel);
          const confirm = await channel.receiveRaw();
          channel.authorize();
          await channel.sendText(JSON.stringify({ type: "pong", echo: confirm }));
        },
      };
    },
  };
  const host = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys: keys,
    account: { grant: async () => mint("machine", "user_a", id) },
    nk,
    onClientChannel: (channel) => {
      arrived.push(channel);
      channel.close();
    },
  });
  cleanups.push(() => host.close());
  return { id, key: keys.publicKey, arrived };
}

function nkFirst(key: Uint8Array, early: string) {
  const noise = NoiseNK.initiator({
    remoteStatic: key,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  });
  return { noise, first: noise.writeMessage(new TextEncoder().encode(early)) };
}

/** Sends `confirm` as one JSON fragment and reads the daemon's one JSON fragment back. */
async function confirmed(
  client: Awaited<ReturnType<typeof openPeer>>,
  noise: NoiseNK,
  confirm: string,
): Promise<string> {
  const body = new TextEncoder().encode(confirm);
  const plain = new Uint8Array(body.length + 1);
  plain[0] = 1;
  plain.set(body, 1);
  await client.send(noise.transport.send.encrypt(plain));
  const reply = noise.transport.receive.decrypt(await client.next());
  return new TextDecoder().decode(reply.subarray(1));
}

it("an NK first message held as the early frame is answered once the daemon joins", async () => {
  const d = await daemon((early) => early === "early hello");
  const client = await openPeer(
    address(worker.relayUrl, "/client", { hostId: d.id, [EARLY_FRAME.query]: "1" }),
    [deviceGrant(), EARLY_FRAME.subprotocol],
  );
  expect(client.protocol).toBe(EARLY_FRAME.subprotocol);
  const { noise, first } = nkFirst(d.key, "early hello");
  await client.send(first);
  expect([...(await client.next())]).toEqual([EARLY_FRAME.capableMarker]);
  expect(noise.readMessage(await client.next())).toHaveLength(0);
  expect(JSON.parse(await confirmed(client, noise, '{"type":"hello.confirm"}'))).toMatchObject({
    type: "pong",
  });
});

it("an NK first message sent after the marker is answered the same way", async () => {
  const d = await daemon(() => true);
  const client = await openPeer(address(worker.relayUrl, "/client", { hostId: d.id }), [
    deviceGrant(),
  ]);
  expect([...(await client.next())]).toEqual([1]);
  const { noise, first } = nkFirst(d.key, "hello");
  await client.send(first);
  expect(noise.readMessage(await client.next())).toHaveLength(0);
  expect(await confirmed(client, noise, '{"type":"hello.confirm"}')).toContain("pong");
});

it("a refused NK first message reaches the client as a close with nothing sent", async () => {
  const d = await daemon(() => false);
  const client = await openPeer(address(worker.relayUrl, "/client", { hostId: d.id }), [
    deviceGrant(),
  ]);
  expect([...(await client.next())]).toEqual([1]);
  await client.send(nkFirst(d.key, "refused").first);
  await expect(client.next()).rejects.toThrow();
  expect(d.arrived).toHaveLength(0);
});

it("an XX client reaches the same daemon as before", async () => {
  const d = await daemon(() => true);
  const client = await openPeer(address(worker.relayUrl, "/client", { hostId: d.id }), [
    deviceGrant(),
  ]);
  expect([...(await client.next())]).toEqual([1]);
  await initiate(client, STREAM, keyPair(), d.id);
  // The host took it as XX: its channel went to the ordinary handler.
  // Waits for it; the test's timeout is the only limit.
  while (d.arrived.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(d.arrived).toHaveLength(1);
});
