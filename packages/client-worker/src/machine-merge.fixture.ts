import {
  Client,
  type Credential,
  type PortableSocket,
  type Storage,
  type Transport,
} from "@ace/client";
import { MachineDirectory, type MachineEntry, type PairedMachine } from "@ace/client/machines";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { adoptedOutbox } from "./adopted-outbox.ts";
import { ClientHost } from "./index.ts";
import { MachinePool, type MachineWorker, type OffMachines } from "./machines.ts";

export const token = "e".repeat(64);
/** What an account connection that `accountOverRelay` stands in for signs in with. */
export const accountToken = "a".repeat(64);
export const fingerprint = "c".repeat(64);
export const relayKey = "A".repeat(52);
export const lan = "https://192.168.1.4:7443";
const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const pools: MachinePool[] = [];
/** For `afterEach`: close every pool a test opened. */
export async function closePools(): Promise<void> {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
}

/** ace's relay, out of reach: every socket to it fails. */
function unreachable(): PortableSocket {
  const closes: ((event?: { code?: number }) => void)[] = [];
  setTimeout(() => {
    for (const close of closes) close({ code: 1006 });
  }, 0);
  return {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    addEventListener: ((type: string, listener: (event?: { code?: number }) => void) => {
      if (type === "close") closes.push(listener);
    }) as PortableSocket["addEventListener"],
    send() {},
    close() {},
  };
}

export interface WorldOptions {
  /** Where the pool keeps machines turned off. */
  off?: OffMachines;
  /** This app's device id on the ace account. */
  accountDeviceId?: string;
  /** The account's device grants; a rejection is the backend refusing this device. */
  grant?: () => Promise<string>;
  /** Replaces every account connection's transport, to stage what the daemon answers. */
  accountTransport?: () => Transport;
  /**
   * The account entry reaches the daemon through a working relay: its connection goes straight
   * to the fake daemon and reports the relay path, so the pool learns the daemon's id from it.
   * Each such connection is recorded in `accountSockets`.
   */
  accountOverRelay?: boolean;
}

/**
 * A pool on a daemon reachable only on the LAN, at the address it was paired at. Its own
 * account machine is known to ace's relay as `relayKey`, which is unreachable. The account's
 * direct routes, as in a browser, take only the paired address (`paired`); each records the
 * credential the pool gave it for its hellos (`accountCredentials`).
 */
export function world(options: WorldOptions = {}) {
  const daemon = new FakeDaemon({
    clock: () => 1_000,
    hostId: "host",
    displayName: "Office Mac",
    token,
  });
  let accepted = token;
  daemon.accepts = (credential) =>
    credential.token === accepted || credential.token === accountToken;
  daemon.paths = [
    { kind: "lan", url: lan, fingerprint },
    { kind: "account", url: "wss://relay.acehq.dev", relayHostId: relayKey },
  ];
  let saved: string | null = null;
  const secrets = new Map<string, string>();
  const directory = new MachineDirectory(
    { load: async () => saved, save: async (value) => void (saved = value) },
    {
      get: async (key) => secrets.get(key) ?? null,
      set: async (key, value) => void secrets.set(key, value),
      delete: async (key) => void secrets.delete(key),
    },
  );
  /**
   * Each client's outbox, as the browser keeps them: a paired worker's one record per send
   * bound to its daemon (`paired:<host>:<device>`), an account machine's one saved value
   * (`account:<host>`).
   */
  const outboxes = new Map<string, Map<string, string>>();
  const records = (key: string): Map<string, string> => {
    let kept = outboxes.get(key);
    if (!kept) outboxes.set(key, (kept = new Map()));
    return kept;
  };
  const bindings = new Map<string, string>();
  const pairedOutbox = (entry: { hostId: string; deviceId: string }): Storage => {
    const key = `paired:${entry.hostId}:${entry.deviceId}`;
    return {
      hostBinding: {
        load: async () => bindings.get(key) ?? null,
        save: async (hostId) => void bindings.set(key, hostId),
      },
      records: {
        load: async () => [...records(key).values()],
        write: async (id, value) => {
          if (value === null) records(key).delete(id);
          else records(key).set(id, value);
        },
      },
      load: async () => null,
      save: async () => {},
    };
  };
  const accountOutbox = (hostId: string): Storage => {
    const kept = records(`account:${hostId}`);
    return {
      load: async () => kept.get("value") ?? null,
      save: async (value) => void kept.set("value", value),
    };
  };
  let sequence = 0;
  const client = (
    transport: () => Transport,
    credential: () => Promise<Credential>,
    expectedHostId?: string,
    outbox: Storage = { load: async () => null, save: async () => {} },
    aliases: readonly string[] = [],
    deviceId = "browser",
  ) =>
    new Client({
      deviceId: DeviceId.parse(deviceId),
      ...(aliases.length ? { deviceAliases: aliases.map((id) => DeviceId.parse(id)) } : {}),
      transport,
      credential,
      storage: outbox,
      scheduler,
      random: () => 0.5,
      id: () => `browser-${++sequence}`,
      ...(expectedHostId ? { expectedHostId: HostId.parse(expectedHostId) } : {}),
    });
  const directDialed: string[] = [];
  const accountSockets: { closed: boolean }[] = [];
  /** An account client's outbox: its own, taking over its pairing's when it stands in for one. */
  const accountStorage = (route: { hostId: string; paired?: MachineEntry }) =>
    route.paired
      ? adoptedOutbox(accountOutbox(route.hostId), pairedOutbox(route.paired), route.paired.hostId)
      : accountOutbox(route.hostId);
  /** A connection to the daemon that the pool sees as running over ace's relay. */
  const overRelay = (route: { hostId: string; paired?: MachineEntry }) => {
    const relayed = client(
      () => {
        const inner = fakeTransport(daemon);
        const socket = { closed: false };
        accountSockets.push(socket);
        return {
          open: (events) => inner.open(events),
          send: (text) => inner.send(text),
          close: () => {
            socket.closed = true;
            inner.close();
          },
        };
      },
      async () => ({ token: accountToken }),
      undefined,
      accountStorage(route),
      route.paired ? [route.paired.deviceId] : [],
    );
    return Object.assign(relayed, {
      usePaths() {},
      activePath: () => ({ getSnapshot: () => "account" as const, subscribe: () => () => {} }),
    });
  };
  const accountCredentials: (() => Promise<Credential>)[] = [];
  /** Every paired worker started: the token it was given, and whether it was stopped. */
  const workers: { token: string; terminated: boolean }[] = [];
  const pool = new MachinePool({
    directory,
    remote: { scheduler },
    ...(options.off ? { off: options.off } : {}),
    spawn(entry, credential): MachineWorker {
      const worker = { token: credential, terminated: false };
      workers.push(worker);
      // Terminating a real worker ends its client with it; this one runs in the test's thread.
      let made: Client | undefined;
      const host = new ClientHost({
        target: () => ({
          key: entry.hostId,
          create: () =>
            (made = client(
              () => fakeTransport(daemon),
              async () => ({ token: credential }),
              entry.hostId,
              pairedOutbox(entry),
              [],
              entry.deviceId,
            )),
        }),
        scheduler,
        now: () => Date.now(),
        frameMs: 4,
        lingerMs: 1,
      });
      const { port1, port2 } = new MessageChannel();
      host.attach(port1);
      return {
        port: port2,
        config: {},
        terminate: () => {
          worker.terminated = true;
          void made?.close().catch(() => {});
          port1.close();
          port2.close();
        },
        onFailure: () => () => {},
      };
    },
    account: {
      relayUrl: "wss://relay.acehq.dev",
      deviceId: options.accountDeviceId ?? "browser",
      grant: options.grant ?? (async () => "grant"),
      socket: unreachable,
      directRoute: (path, credential, paired) => {
        if (!paired) return undefined;
        directDialed.push(path.url);
        accountCredentials.push(credential);
        return { transport: () => fakeTransport(daemon), credential: async () => ({ token }) };
      },
      client: (route) =>
        options.accountOverRelay
          ? overRelay(route)
          : client(
              options.accountTransport ?? route.transport,
              route.credential,
              route.expectedHostId,
              accountStorage(route),
              route.paired ? [route.paired.deviceId] : [],
            ),
    },
  });
  pools.push(pool);
  /**
   * This install paired the machine again somewhere else (another window): the daemon now takes
   * only `next` and closes the old token's sockets, and the shared secret store holds `next`.
   */
  const pairAgainElsewhere = (next: string) => {
    accepted = next;
    for (const key of secrets.keys()) secrets.set(key, next);
    daemon.disconnectAll(4001);
  };
  return {
    pool,
    daemon,
    directory,
    directDialed,
    accountCredentials,
    accountSockets,
    outboxes,
    workers,
    pairAgainElsewhere,
  };
}

/** What pairing in a browser saves: the address alone, with no fingerprint of its own. */
export const browserPairing: PairedMachine = {
  identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
  target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
  deviceId: "browser-paired",
  token,
};

export async function until(check: () => boolean) {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
