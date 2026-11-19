import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { GRANT_LIFETIME_MS } from "@ace/account-grant";
import { Client, relayRoute } from "@ace/client";
import { aceAccountClient } from "@ace/client/ace-account";
import { DeviceId, type ServerMessage } from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { NK_STREAM_PROLOGUE, PAIRED_MARKER } from "@ace/relay/wire";
import { address, initiate, openPeer, STREAM } from "@ace/relay/testing";
import { NoiseNK, keyPair, type SessionKeys } from "@ace/secure-channel";
import { machineAccount } from "./account-access/machine-account.ts";
import { startFakeAccountBackend } from "./account-backend-test-support.ts";
import { eventually, recordedSockets } from "./relay-nk-test-support.ts";
import { fixture } from "./socket-test-support.ts";

// An NK session is an XX session in every field of its welcome and every keeper it starts
// (ADR 0155, step 2), for a paired device and for an account device, whose grant keeper must
// carry an NK connection past its grant's lifetime.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** A daemon on an ace account behind the self-hosted relay; its grants live `grantLeftMs`. */
async function accountDaemon(grantLeftMs = GRANT_LIFETIME_MS) {
  const backend = await startFakeAccountBackend(
    () => Date.now() - (GRANT_LIFETIME_MS - grantLeftMs),
  );
  cleanup.push(() => backend.close());
  const root = await mkdtemp(join(tmpdir(), "ace-nk-account-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const relay = await startRelay();
  cleanup.push(() => relay.close());
  const relayKeys = keyPair();
  const hostKey = relayKeys.publicKey.slice();
  let account: ReturnType<typeof machineAccount> | undefined;
  const f = await fixture({ relay: { url: relay.url, keys: relayKeys } }, (store) => {
    account = machineAccount({
      relayKeys: async () => keyPair(new Uint8Array(32).fill(3)),
      dataDir: root,
      codes: store.machineCodes,
      fetch: globalThis.fetch,
      now: Date.now,
      randomBytes,
      delay: (run, milliseconds) => {
        const timer = setTimeout(run, milliseconds);
        return () => clearTimeout(timer);
      },
    });
    return { machineAccount: account };
  });
  cleanup.push(() => f.close());
  cleanup.push(() => account?.close());
  await account?.handover(backend.origin, { token: backend.token });
  const accounts = aceAccountClient({ origin: backend.origin, fetch: globalThis.fetch });
  const grant = async (deviceId: string) =>
    (
      await accounts.grant(
        backend.token,
        { kind: "device", subject: DeviceId.parse(deviceId) },
        AbortSignal.timeout(5000),
      )
    ).token;
  const paired = f.store.devices.create("Phone", ["read", "operate"], Date.now());
  /** Device grants the backend issued: one per connect, and one per keeper refresh. */
  const deviceGrants = () => backend.grantRequests.filter((body) => body.kind === "device").length;
  return { f, relay, hostId: f.server.relayHostId ?? "", hostKey, grant, paired, deviceGrants };
}

type Daemon = Awaited<ReturnType<typeof accountDaemon>>;

function sealed(peer: Awaited<ReturnType<typeof openPeer>>, keys: SessionKeys) {
  const decoder = new TextDecoder();
  return {
    async send(message: unknown) {
      const body = new TextEncoder().encode(JSON.stringify(message));
      const plain = new Uint8Array(body.length + 1);
      plain[0] = 1;
      plain.set(body, 1);
      await peer.send(keys.send.encrypt(plain));
    },
    async until<T extends ServerMessage["type"]>(type: T) {
      for (;;) {
        const plain = keys.receive.decrypt(await peer.next());
        if (plain[0] !== 1) continue;
        const message = JSON.parse(decoder.decode(plain.subarray(1))) as ServerMessage;
        if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
      }
    },
  };
}

async function dial(d: Daemon) {
  const peer = await openPeer(address(d.relay.url, "/client", { hostId: d.hostId }));
  cleanup.push(() => peer.close());
  expect([...(await peer.next())]).toEqual([PAIRED_MARKER]);
  return peer;
}

/** The welcome over XX for `hello`'s credential. */
async function xxWelcome(d: Daemon, hello: Record<string, unknown>) {
  const peer = await dial(d);
  const channel = sealed(peer, await initiate(peer, STREAM, keyPair(), d.hostId));
  await channel.send({ type: "hello", protocolVersion: 1, flowControl: ["credit"], ...hello });
  return channel.until("welcome");
}

/** The welcome over NK for `early`'s credential, then the confirmation's answer. */
async function nkWelcome(d: Daemon, early: Record<string, unknown>) {
  const peer = await dial(d);
  const noise = NoiseNK.initiator({
    remoteStatic: d.hostKey,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  });
  await peer.send(
    noise.writeMessage(
      new TextEncoder().encode(
        JSON.stringify({
          type: "hello.early",
          protocolVersion: 1,
          flowControl: ["credit"],
          ...early,
        }),
      ),
    ),
  );
  noise.readMessage(await peer.next());
  const channel = sealed(peer, noise.transport);
  await channel.send({ type: "hello.confirm", nextTicket: true });
  return channel.until("welcome");
}

/** A welcome's fields, with the values that differ between any two connects made comparable. */
function fields(welcome: Extract<ServerMessage, { type: "welcome" }>) {
  const { headSeq, grantTtlMs, ticket, standingNonce, ...rest } = welcome;
  return {
    ...rest,
    headSeq: typeof headSeq,
    // Every socket has its own nonce for proving the person's standing (ADR 0190).
    standingNonce: standingNonce === undefined ? "absent" : "own",
    grantTtlMs: grantTtlMs === undefined ? "absent" : grantTtlMs > 60_000 ? "minutes" : "short",
    // XX hands the next ticket in the welcome; NK in `hello.confirmed`, after the confirmation.
    ticket: ticket === undefined ? "absent" : "handed",
  };
}

it("a paired device's NK welcome has every field its XX welcome has", async () => {
  const d = await accountDaemon();
  const xx = await xxWelcome(d, {
    deviceId: d.paired.device.id,
    token: d.paired.token,
    nextTicket: true,
  });
  const nk = await nkWelcome(d, { deviceId: d.paired.device.id, ticket: xx.ticket?.ticket });
  expect(fields(nk)).toEqual({ ...fields(xx), ticket: "absent" });
});

it("an account device's NK welcome has every field its XX welcome has, its grant's time left included", async () => {
  const d = await accountDaemon();
  const xx = await xxWelcome(d, { deviceId: "phone", grant: await d.grant("phone") });
  expect(xx.grantTtlMs).toBeGreaterThan(60_000);
  const nk = await nkWelcome(d, { deviceId: "phone", grant: await d.grant("phone") });
  expect(fields(nk)).toEqual(fields(xx));
});

it("an account device's NK connection is carried past its grant's lifetime by its grant keeper", async () => {
  // Grants live 4 s here, so the keeper refreshes every 2 s. Without the keeper the daemon would
  // close the socket only after a 30 s grace, so the refreshes are what this watches.
  const d = await accountDaemon(4_000);
  const sockets = recordedSockets();
  const route = relayRoute({
    relayUrl: d.relay.url,
    hostId: d.hostId,
    credential: async () => ({ grant: await d.grant("phone") }),
    socket: sockets.socket,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  });
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: route.transport,
    credential: route.credential,
    // What keeps a socket's grant fresh (`account.grant.refresh`).
    grant: () => d.grant("phone"),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0.5,
    id: () => `phone-${Math.random()}`,
  });
  cleanup.push(() => client.close());
  await client.start();
  await eventually(() => client.state === "ready");
  sockets.drop();
  await eventually(() => sockets.dials.length === 2);
  await eventually(() => client.state === "ready");
  expect(sockets.patterns()).toEqual(["xx", "nk"]);
  const connected = d.deviceGrants();
  // Four refreshes later (past three grant lifetimes), still the same NK connection.
  await eventually(() => d.deviceGrants() - connected >= 4);
  expect(sockets.dials).toHaveLength(2);
  expect(client.state).toBe("ready");
  expect(d.deviceGrants() - connected).toBeGreaterThanOrEqual(4);
}, 30_000);
