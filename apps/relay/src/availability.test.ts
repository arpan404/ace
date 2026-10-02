import { afterEach, expect, it } from "vitest";
import { keyPair } from "@ace/secure-channel";
import { startRelay, connectHostToRelay, connectClientViaRelay } from "./index.ts";
import {
  register,
  address,
  openPeer,
  initiate,
  STREAM,
  Offer,
  json,
  deferred,
} from "./testing/peer.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).toReversed()) await finish();
});
it("a fresh proof replaces a stale host registration without waiting for idle expiry", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const stale = await register(relay.url, keys);
  cleanup.push(() => stale.close());
  stale.socket.pause();
  const fresh = await register(relay.url, keys);
  cleanup.push(() => fresh.close());
  expect(fresh.hostId).toBe(stale.hostId);
  const client = await openPeer(address(relay.url, "/client", { hostId: fresh.hostId }));
  cleanup.push(() => client.close());
  expect(Offer.parse(json(fresh.transport.receive.decrypt(await fresh.next()))).ticket).toMatch(
    /^[a-f0-9]{64}$/,
  );
  stale.socket.resume();
  expect(await stale.closed).toBeGreaterThanOrEqual(1000);
});
it("local close ends a pending async iterator normally", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<void>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel() {
      arrived.resolve();
    },
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  await arrived.promise;
  const pending = client[Symbol.asyncIterator]().next();
  client.close();
  expect(await pending).toEqual({ done: true, value: undefined });
});
it("a client sending data before the authenticated host joins is rejected", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const host = await register(relay.url);
  cleanup.push(() => host.close());
  const early = await openPeer(address(relay.url, "/client", { hostId: host.hostId }));
  cleanup.push(() => early.close());
  const offer = Offer.parse(json(host.transport.receive.decrypt(await host.next())));
  await early.send(new Uint8Array([1]));
  const join = await openPeer(address(relay.url, "/join", { ticket: offer.ticket }));
  cleanup.push(() => join.close());
  const result = await Promise.race([
    early.closed.then((code) => ({ closed: code })),
    join.next().then(
      () => ({ forwarded: true }),
      () => ({ joinClosed: true }),
    ),
  ]);
  expect(result).toEqual({ closed: 1008 });
});
it("a full host evicts its oldest unauthenticated channel so a paired device can reach it", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived: ReturnType<typeof deferred<void>>[] = [];
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel() {
      arrived.shift()?.resolve();
    },
  });
  cleanup.push(() => host.close());
  const squatters = [];
  for (let i = 0; i < 64; i++) {
    const ready = deferred<void>();
    arrived.push(ready);
    const squatter = await openPeer(address(relay.url, "/client", { hostId: host.hostId }));
    cleanup.push(() => squatter.close());
    await squatter.next();
    await initiate(squatter, STREAM, keyPair(), host.hostId);
    await ready.promise;
    squatters.push(squatter);
  }
  const ready = deferred<void>();
  arrived.push(ready);
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  await ready.promise;
  const oldest = squatters[0];
  if (!oldest) throw new Error("No squatter");
  expect(await oldest.closed).toBe(1006);
});
it("an unverified hello expires and cannot reserve a device slot indefinitely", async () => {
  const { ManualClock } = await import("./testing/clock.ts");
  const { DeviceId } = await import("@ace/protocol");
  const clock = new ManualClock();
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<import("./index.ts").HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    clock,
    limits: { helloTimeoutMs: 25 },
    onClientChannel: arrived.resolve,
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const channel = await arrived.promise;
  expect(() => channel.authorize()).toThrow("hello");
  await client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("unpaired"),
    token: "invalid token",
  });
  expect(await channel.receive()).toMatchObject({ token: "invalid token" });
  clock.advance(25);
  await expect(channel.send({ type: "pong" })).rejects.toThrow("closed");
  await client.closed;
  expect(await channel.closed).toBeUndefined();
});
it("every authorized slot remains usable while excess clients are rejected", async () => {
  const { DeviceId } = await import("@ace/protocol");
  let arrived = deferred<import("./index.ts").HostChannel>();
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    limits: { maxClientChannels: 2 },
    onClientChannel: (channel) => arrived.resolve(channel),
  });
  cleanup.push(() => host.close());
  const accepted = [];
  for (let i = 0; i < 2; i++) {
    arrived = deferred<import("./index.ts").HostChannel>();
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
    });
    cleanup.push(() => client.close());
    const server = await arrived.promise;
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(`device-${i}`),
      token: "validated by daemon",
    });
    await server.receive();
    server.authorize();
    accepted.push({ client, server });
  }
  await expect(
    connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: host.hostId,
    }),
  ).rejects.toThrow("closed");
  for (const { client, server } of accepted) {
    await server.send({ type: "pong" });
    expect(await client.receive()).toEqual({ type: "pong" });
  }
});
it("the host rejects application traffic before a device hello", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const arrived = deferred<import("./index.ts").HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: arrived.resolve,
  });
  cleanup.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanup.push(() => client.close());
  const server = await arrived.promise;
  await client.send({ type: "ping" });
  await expect(server.receive()).rejects.toThrow("First message must be hello");
  await client.closed;
});
it("a personal relay only registers allowlisted proven host keys", async () => {
  const { hostId } = await import("@ace/secure-channel");
  const allowed = keyPair();
  const relay = await startRelay({ allowedHostIds: [hostId(allowed.publicKey)] });
  cleanup.push(() => relay.close());
  const denied = await openPeer(address(relay.url, "/host"));
  cleanup.push(() => denied.close());
  await initiate(denied, new TextEncoder().encode("ace relay registration v1"));
  expect(await denied.closed).toBe(1008);
  const registered = await register(relay.url, allowed);
  cleanup.push(() => registered.close());
  expect(registered.hostId).toBe(hostId(allowed.publicKey));
});
it("a newer daemon registration stops the old owner from reconnecting over it", async () => {
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const keys = keyPair();
  const older = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keys,
    onClientChannel() {},
  });
  cleanup.push(() => older.close());
  const rejected = expect(older.whenRegistered(older.generation)).rejects.toThrow("closed");
  const newer = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keys,
    onClientChannel() {},
  });
  cleanup.push(() => newer.close());
  await rejected;
  expect(newer.generation).toBe(1);
});
