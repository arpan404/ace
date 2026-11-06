import { Client, type Credential, type PortableSocket, type Transport } from "@ace/client";
import { MachineDirectory, type PairedMachine } from "@ace/client/machines";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { ClientHost } from "./index.ts";
import { MachinePool, type MachineWorker, type OffMachines } from "./machines.ts";

export const token = "e".repeat(64);
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
  daemon.accepts = (credential) => credential.token === accepted;
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
  let sequence = 0;
  const client = (
    transport: () => Transport,
    credential: () => Promise<Credential>,
    expectedHostId?: string,
  ) =>
    new Client({
      deviceId: DeviceId.parse("browser"),
      transport,
      credential,
      storage: { load: async () => null, save: async () => {} },
      scheduler,
      random: () => 0.5,
      id: () => `browser-${++sequence}`,
      ...(expectedHostId ? { expectedHostId: HostId.parse(expectedHostId) } : {}),
    });
  const directDialed: string[] = [];
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
      const host = new ClientHost({
        target: () => ({
          key: entry.hostId,
          create: () =>
            client(
              () => fakeTransport(daemon),
              async () => ({ token: credential }),
              entry.hostId,
            ),
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
        client(options.accountTransport ?? route.transport, route.credential, route.expectedHostId),
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
  return { pool, daemon, directory, directDialed, accountCredentials, workers, pairAgainElsewhere };
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
