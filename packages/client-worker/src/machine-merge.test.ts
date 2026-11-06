import { afterEach, expect, test } from "vitest";
import { Client, type PortableSocket } from "@ace/client";
import { MachineDirectory, type PairedMachine } from "@ace/client/machines";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { ClientHost } from "./index.ts";
import { MachinePool, type MachineWorker } from "./machines.ts";

const token = "e".repeat(64);
const fingerprint = "c".repeat(64);
const relayKey = "A".repeat(52);
const lan = "https://192.168.1.4:7443";
const scheduler = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const pools: MachinePool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

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

/**
 * A pool on a daemon reachable only on the LAN, at the address it was paired at. Its own
 * account machine is known to ace's relay as `relayKey`, which is unreachable. The account's
 * direct routes, as in a browser, take only the paired address (`paired`).
 */
function world() {
  const daemon = new FakeDaemon({
    clock: () => 1_000,
    hostId: "host",
    displayName: "Office Mac",
    token,
  });
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
    transport: () => import("@ace/client").Transport,
    credential: () => Promise<import("@ace/client").Credential>,
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
  const pool = new MachinePool({
    directory,
    remote: { scheduler },
    spawn(entry, credential): MachineWorker {
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
          port1.close();
          port2.close();
        },
        onFailure: () => () => {},
      };
    },
    account: {
      relayUrl: "wss://relay.acehq.dev",
      deviceId: "browser",
      grant: async () => "grant",
      socket: unreachable,
      directRoute: (path, _credential, paired) => {
        if (!paired) return undefined;
        directDialed.push(path.url);
        return { transport: () => fakeTransport(daemon), credential: async () => ({ token }) };
      },
      client: (route) => client(route.transport, route.credential, route.expectedHostId),
    },
  });
  pools.push(pool);
  return { pool, directory, directDialed };
}

/** What pairing in a browser saves: the address alone, with no fingerprint of its own. */
const browserPairing: PairedMachine = {
  identity: { hostId: HostId.parse("host"), displayName: "Office Mac", version: "1" },
  target: { kind: "direct", url: "wss://192.168.1.4:7443/" },
  deviceId: "browser-paired",
  token,
};

async function until(check: () => boolean) {
  const deadline = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("an account machine whose relay is out of reach takes the direct route once the app pairs it, listed once", async () => {
  const f = world();
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status !== "connecting");
  expect(f.pool.machine(relayKey)?.status).not.toBe("online");

  await f.pool.add({
    ...browserPairing,
    target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint },
  });
  // The pairing said over its connection that ace's relay knows it by `relayKey`: one machine.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.ids).toEqual([relayKey]);
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
  expect(f.directDialed).toContain(lan);
});

test("a machine paired in a browser and opened through the account keeps the LAN route it was paired at", async () => {
  const f = world();
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");
  await until(() => (f.directory.machines[0]?.paths?.length ?? 0) > 0);

  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  expect(f.pool.ids).toEqual([relayKey]);
  // The paired connection stepped aside; the account entry reaches the same daemon on the LAN.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
});
