import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { DeviceId } from "@ace/protocol";
import {
  GRANT_LIFETIME_MS,
  GRANT_SUBPROTOCOL_PREFIX,
  GrantKeySet,
  grantPublicKey,
} from "@ace/account-grant";
import { FLOW_WINDOW, hostId, keyPair } from "@ace/secure-channel";
import type { KeyPair } from "@ace/secure-channel";
import { connectClientViaRelay, connectHostToRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { address, CONTROL, deferred, initiate, openPeer, STREAM } from "@ace/relay/testing";
import { WebSocket } from "ws";
import { PAIRED_MARKER } from "@ace/relay/wire";
import { mint, startWorker, upgrade } from "./testing/harness.ts";

let worker: Awaited<ReturnType<typeof startWorker>>;
const cleanups: (() => unknown)[] = [];
beforeAll(async () => {
  worker = await startWorker();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
afterAll(() => worker.close());

const hostGrant = (account: string, keys: KeyPair) => async () =>
  mint("machine", account, hostId(keys.publicKey));

async function host(
  options: { account?: string; limits?: Parameters<typeof connectHostToRelay>[0]["limits"] } = {},
) {
  const account = options.account ?? "user_a";
  const hostKeys = keyPair();
  let next = deferred<HostChannel>();
  const connection = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    limits: options.limits ?? {},
    account: { grant: hostGrant(account, hostKeys), name: "Studio Mac", platform: "darwin" },
    onClientChannel: (channel) => next.resolve(channel),
  });
  cleanups.push(() => connection.close());
  const client = (grant = mint("device", account, "phone")) =>
    connectClientViaRelay({
      relayUrl: worker.relayUrl,
      hostId: connection.hostId,
      pinnedFingerprint: connection.hostId,
      grant,
    });
  async function connect() {
    next = deferred<HostChannel>();
    const opened = await client();
    cleanups.push(() => opened.close());
    const server = await next.promise;
    await opened.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      token: "device token",
    });
    expect(await server.receive()).toMatchObject({ type: "hello", token: "device token" });
    server.authorize();
    return { client: opened, server };
  }
  /**
   * A device that speaks the relay's wire itself, as the iPhone does: it reads every frame as it
   * arrives with no queue limit and sends without pacing.
   */
  async function rawDevice() {
    next = deferred<HostChannel>();
    const url = address(worker.relayUrl, "/client", { hostId: connection.hostId });
    const device = await openPeer(url, deviceProtocol(account));
    cleanups.push(() => device.close());
    expect([...(await device.next())]).toEqual([PAIRED_MARKER]);
    const transport = await initiate(device, STREAM, keyPair(), connection.hostId);
    const sendJson = (message: object) => {
      const json = new TextEncoder().encode(JSON.stringify(message));
      const plain = new Uint8Array(json.length + 1);
      plain[0] = 1; // A JSON message's last (and only) fragment.
      plain.set(json, 1);
      return device.send(transport.send.encrypt(plain));
    };
    await sendJson({ type: "hello", protocolVersion: 1, deviceId: "phone", token: "t" });
    const server = await next.promise;
    expect(await server.receive()).toMatchObject({ type: "hello" });
    server.authorize();
    return { device, transport, sendJson, server };
  }
  return { connection, hostKeys, connect, client, rawDevice };
}

const deviceProtocol = (account: string) => [
  GRANT_SUBPROTOCOL_PREFIX + mint("device", account, "phone"),
];

it("a daemon and a device on the same account exchange encrypted messages in both directions", async () => {
  const { connect } = await host();
  const first = await connect();
  const second = await connect();
  await first.client.send({ type: "ping" });
  expect(await first.server.receive()).toEqual({ type: "ping" });
  await second.server.send({ type: "pong" });
  expect(await second.client.receive()).toEqual({ type: "pong" });
  first.client.close();
  await first.server.closed;
  await second.client.send({ type: "ping" });
  expect(await second.server.receive()).toEqual({ type: "ping" });
});

it("a registered machine is listed under the account its grant names", async () => {
  const { connection } = await host({ account: "user_listed" });
  const row = await worker.db
    .prepare("SELECT account_id, name, platform FROM machines WHERE host_id = ?")
    .bind(connection.hostId)
    .first();
  expect(row).toEqual({ account_id: "user_listed", name: "Studio Mac", platform: "darwin" });
});

it("a device on another account is told the machine is not theirs", async () => {
  const { connection, client } = await host({ account: "user_a" });
  const url = address(worker.relayUrl, "/client", { hostId: connection.hostId });
  expect(await upgrade(url, deviceProtocol("user_b"))).toMatchObject({
    code: 4403,
    reason: "Not your machine",
  });
  await expect(client(mint("device", "user_b", "phone"))).rejects.toThrow();
});

it("upgrades without a valid grant are refused before reaching a machine", async () => {
  const { connection, hostKeys } = await host();
  const target = { hostId: connection.hostId };
  const clientUrl = address(worker.relayUrl, "/client", target);
  const hostUrl = address(worker.relayUrl, "/host", target);
  const expired = mint("device", "user_a", "phone", { iat: Date.now() - GRANT_LIFETIME_MS - 1 });
  const forged = mint("device", "user_a", "phone", {
    key: { id: "test", privateKey: crypto.getRandomValues(new Uint8Array(32)) },
  });
  expect(await upgrade(clientUrl)).toEqual({ status: 401 });
  for (const grant of [expired, forged, mint("machine", "user_a", connection.hostId)])
    expect(await upgrade(clientUrl, [GRANT_SUBPROTOCOL_PREFIX + grant])).toEqual({ status: 401 });
  expect(await upgrade(hostUrl)).toEqual({ status: 401 });
  expect(
    await upgrade(hostUrl, [GRANT_SUBPROTOCOL_PREFIX + mint("device", "user_a", "phone")]),
  ).toEqual({ status: 401 });
  // A machine grant names one host id; it cannot register another.
  const other = hostId(keyPair().publicKey);
  expect(
    await upgrade(address(worker.relayUrl, "/host", { hostId: other }), [
      GRANT_SUBPROTOCOL_PREFIX + (await hostGrant("user_a", hostKeys)()),
    ]),
  ).toEqual({ status: 403 });
});

it("the relay echoes the offered grant subprotocol", async () => {
  const { connection } = await host();
  const offered = deviceProtocol("user_a");
  const socket = new WebSocket(
    address(worker.relayUrl, "/client", { hostId: connection.hostId }),
    offered,
  );
  cleanups.push(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  expect(socket.protocol).toBe(offered[0]);
});

it("a daemon with every channel authorized turns a new client away as busy", async () => {
  const { connect, client } = await host({ limits: { maxClientChannels: 1 } });
  await connect();
  const started = Date.now();
  await expect(client()).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(3_000);
});

it("a device asking for a machine that is not connected is refused at once", async () => {
  const missing = hostId(keyPair().publicKey);
  const url = address(worker.relayUrl, "/client", { hostId: missing });
  const started = Date.now();
  expect(await upgrade(url, deviceProtocol("user_a"))).toMatchObject({
    code: 1008,
    reason: "Host unavailable",
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});

it("a key that does not own the claimed host id cannot register under it", async () => {
  const victim = hostId(keyPair().publicKey);
  const attacker = await openPeer(address(worker.relayUrl, "/host", { hostId: victim }), [
    GRANT_SUBPROTOCOL_PREFIX + mint("machine", "user_a", victim),
  ]);
  cleanups.push(() => attacker.close());
  await initiate(attacker, CONTROL, keyPair());
  expect(await attacker.closed).toBe(1008);
  expect(
    await upgrade(
      address(worker.relayUrl, "/client", { hostId: victim }),
      deviceProtocol("user_a"),
    ),
  ).toMatchObject({ code: 1008, reason: "Host unavailable" });
  expect(
    await worker.db.prepare("SELECT 1 FROM machines WHERE host_id = ?").bind(victim).first(),
  ).toBeNull();
});

it("a newer registration of the same daemon takes over its clients", async () => {
  const hostKeys = keyPair();
  const account = { grant: hostGrant("user_a", hostKeys) };
  const stale: HostChannel[] = [];
  const old = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account,
    onClientChannel: (channel) => void stale.push(channel),
  });
  cleanups.push(() => old.close());
  const fresh = deferred<HostChannel>();
  const current = await connectHostToRelay({
    relayUrl: worker.relayUrl,
    hostKeys,
    account,
    onClientChannel: fresh.resolve,
  });
  cleanups.push(() => current.close());
  const client = await connectClientViaRelay({
    relayUrl: worker.relayUrl,
    hostId: current.hostId,
    pinnedFingerprint: current.hostId,
    grant: mint("device", "user_a", "phone"),
  });
  cleanups.push(() => client.close());
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
  });
  expect(await (await fresh.promise).receive()).toMatchObject({ type: "hello" });
  expect(stale).toEqual([]);
});

it("a relay without account settings admits no host or device", async () => {
  const bare = await startWorker({ accounts: false });
  cleanups.push(() => bare.close());
  const id = hostId(keyPair().publicKey);
  const protocols = [GRANT_SUBPROTOCOL_PREFIX + mint("machine", "user_a", id)];
  expect(await upgrade(address(bare.relayUrl, "/host", { hostId: id }), protocols)).toEqual({
    status: 503,
  });
  expect(await upgrade(address(bare.relayUrl, "/client", { hostId: id }), protocols)).toEqual({
    status: 503,
  });
  const response = await fetch(`${bare.http}/v1/account/login`, { method: "POST" });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "account_not_configured" });
});

it("while a rotation keeps the replaced key, grants it signed still connect; once removed they don't", async () => {
  const replaced = { id: "old", privateKey: crypto.getRandomValues(new Uint8Array(32)) };
  const published = grantPublicKey(replaced);
  const rotating = await startWorker({ previousGrantKey: `old:${published.publicKey}` });
  cleanups.push(() => rotating.close());
  const keys = GrantKeySet.parse(await (await fetch(`${rotating.http}/v1/keys`)).json());
  expect(keys.keys.map((key) => key.id)).toEqual(["test", "old"]);
  expect(keys.keys[1]).toEqual(published);

  const hostKeys = keyPair();
  const id = hostId(hostKeys.publicKey);
  const channel = deferred<HostChannel>();
  const machine = await connectHostToRelay({
    relayUrl: rotating.relayUrl,
    hostKeys,
    account: { grant: async () => mint("machine", "user_a", id, { key: replaced }) },
    onClientChannel: channel.resolve,
  });
  cleanups.push(() => machine.close());
  const device = await connectClientViaRelay({
    relayUrl: rotating.relayUrl,
    hostId: id,
    pinnedFingerprint: id,
    grant: mint("device", "user_a", "phone", { key: replaced }),
  });
  cleanups.push(() => device.close());
  await device.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("phone"),
    token: "t",
  });
  expect(await (await channel.promise).receive()).toMatchObject({ type: "hello" });

  // The Worker without ACE_GRANT_PREVIOUS_KEY: the replaced key's grants are refused.
  const target = { hostId: id };
  for (const [path, kind, subject] of [
    ["/client", "device", "phone"],
    ["/host", "machine", id],
  ] as const)
    expect(
      await upgrade(address(worker.relayUrl, path, target), [
        GRANT_SUBPROTOCOL_PREFIX + mint(kind, "user_a", subject, { key: replaced }),
      ]),
    ).toEqual({ status: 401 });
});

it("a device that stops reading holds the daemon to one window instead of filling the relay object", async () => {
  // A Durable Object can't pause a socket; without credit it buffers all of it (ADR 0110).
  const { connect } = await host();
  const { client, server } = await connect();
  server.flowControl?.();
  await server.send({ type: "pong" });
  await client.receive();
  const size = 60 * 1024;
  const count = 96;
  let written = 0;
  const sends = Array.from({ length: count }, (_, index) => {
    const message = new Uint8Array(size);
    new DataView(message.buffer).setUint32(0, index);
    return server.sendBinary(message).then(() => void (written += size));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(written).toBeLessThanOrEqual(FLOW_WINDOW + size);
  for (let index = 0; index < count; index++) {
    const message = await client.receiveBinary();
    expect(new DataView(message.buffer, message.byteOffset).getUint32(0)).toBe(index);
  }
  await Promise.all(sends);
});

it("a device that sends past the relay's frame budget is told it hit the rate limit", async () => {
  const { rawDevice } = await host();
  const { device, sendJson } = await rawDevice();
  // The relay's per-socket budget is 2,000 frames at once; it can't pause a socket, so it closes.
  // Far more than the budget refills in the time a loaded test machine takes to read them.
  const sends = Array.from({ length: 10_000 }, () => sendJson({ type: "ping" }).catch(() => {}));
  expect(await device.closed).toBe(1008);
  await Promise.all(sends);
});

it("a daemon hears the code and reason its device closed the stream with", async () => {
  const { rawDevice } = await host();
  const { device, server } = await rawDevice();
  device.socket.close(4001, "Path missed its pong");
  expect(await server.closed).toMatchObject({ code: 4001, reason: "Path missed its pong" });
});

it("a device whose connection just drops leaves its daemon a plain peer close", async () => {
  const { rawDevice } = await host();
  const { device, server } = await rawDevice();
  device.close();
  expect(await server.closed).toMatchObject({ code: 1000, reason: "Peer closed" });
});
