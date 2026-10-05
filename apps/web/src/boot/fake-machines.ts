import type { Client } from "@ace/client";
import { ClientError } from "@ace/client";
import { MachineDirectory } from "@ace/client/machines";
import { ClientHost } from "@ace/client-worker";
import { MachinePool } from "@ace/client-worker/machines";
import type { FakeDaemon } from "@ace/fake-daemon";
import { memoryStorage } from "./client.ts";

const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** A device token the in-page directory keeps; the fake daemons authenticate their own. */
const token = "0".repeat(64);

/**
 * A real `MachinePool` over fake daemons in the page (dev:fake and tests): each machine's
 * client runs behind its own `ClientHost` on a `MessageChannel`, the way a dedicated worker
 * would, and the directory and its secrets live in memory. `client` makes the in-page client
 * for one daemon.
 */
export async function fakeMachinePool(
  daemons: readonly FakeDaemon[],
  client: (daemon: FakeDaemon) => Client,
): Promise<MachinePool> {
  const secrets = new Map<string, string>();
  const directory = new MachineDirectory(memoryStorage(), {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => void secrets.set(key, value),
    delete: async (key) => void secrets.delete(key),
  });
  const pool = new MachinePool({
    directory,
    remote: { scheduler: timers },
    spawn(entry) {
      const daemon = daemons.find((each) => each.hostId === entry.hostId);
      if (!daemon) throw new ClientError("offline", "Unknown fake machine");
      const host = new ClientHost({
        target: () => ({ key: entry.hostId, create: () => client(daemon) }),
        scheduler: timers,
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
  });
  await pool.start();
  for (const daemon of daemons)
    await pool.add({
      identity: { hostId: daemon.hostId, displayName: daemon.displayName, version: "0.0.0-fake" },
      target: { kind: "direct", url: `ws://${daemon.hostId}.local:4242` },
      deviceId: "web-fake-device",
      token,
    });
  return pool;
}
