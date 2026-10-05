import { ClientHost } from "@ace/client-worker";
import type { MachinePool } from "@ace/client-worker/machines";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { HostId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { memoryKeyValue } from "@/test/harness.tsx";
import { createBrowserClient, memoryStorage } from "./client.ts";
import { browserMachinePool, directoryKey, type SpawnedWorker } from "./machine-pool.ts";
import { WorkerTarget } from "./worker-target.ts";

const token = "a".repeat(64);
const timers = {
  set(delayMs: number, callback: () => void) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
const pools: MachinePool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

/**
 * Daemons reachable at `ws://<name>.local:4242/`, and dedicated workers that run the client the
 * way `client-worker.ts` does: from the target the pool hands them, nothing else.
 */
function network(...daemons: FakeDaemon[]) {
  const spawned: string[] = [];
  const spawnWorker = (name: string): SpawnedWorker => {
    spawned.push(name);
    const host = new ClientHost({
      target(config) {
        const target = WorkerTarget.parse(config);
        const daemon = daemons.find(
          (each) => target.url === `ws://${each.displayName}.local:4242/`,
        );
        if (!daemon) throw new Error(`Nothing listens at ${target.url}`);
        return {
          key: target.url,
          create: () =>
            createBrowserClient({
              deviceId: target.deviceId,
              transport: () => fakeTransport(daemon),
              credential: async () => target.token,
              storage: memoryStorage(),
              hostId: target.hostId,
            }),
        };
      },
      scheduler: timers,
      now: () => Date.now(),
      frameMs: 4,
      lingerMs: 1,
    });
    const { port1, port2 } = new MessageChannel();
    host.attach(port1);
    return {
      port: port2,
      terminate: () => {
        port1.close();
        port2.close();
      },
      onError: () => () => {},
    };
  };
  return { spawnWorker, spawned };
}
const daemon = (hostId: string, name: string) =>
  new FakeDaemon({ clock: () => 1_000, hostId, displayName: name, token });
const pair = (pool: MachinePool, hostId: string, name: string) =>
  pool.add({
    identity: { hostId: HostId.parse(hostId), displayName: name, version: "1.0.0" },
    target: { kind: "direct", url: `http://${name}.local:4242/` },
    deviceId: "laptop-device",
    token,
  });
async function status(pool: MachinePool, hostId: string, wanted: string) {
  const selection = pool.status(hostId);
  if (selection.getSnapshot()?.status === wanted) return;
  await new Promise<void>((resolve) => {
    const stop = selection.subscribe(() => {
      if (selection.getSnapshot()?.status !== wanted) return;
      stop();
      resolve();
    });
  });
}

test("a machine paired in this browser comes back on the next boot, through its own worker", async () => {
  const build = daemon("build", "build");
  build.projects.seedFolders("/home/ci", [{ path: "/home/ci/api", git: true }]);
  const net = network(build);
  const storage = memoryKeyValue();
  const first = browserMachinePool({ storage, spawnWorker: net.spawnWorker });
  pools.push(first);
  await first.start();
  await pair(first, "build", "build");
  await first.close();
  // The directory keeps where and who, never the device token.
  expect(storage.getItem(directoryKey)).toContain("build.local");
  expect(storage.getItem(directoryKey)).not.toContain(token);

  const next = browserMachinePool({ storage, spawnWorker: net.spawnWorker });
  pools.push(next);
  await next.start();
  await status(next, "build", "online");
  const reply = await next.client("build").projects.home();
  expect(reply.result).toMatchObject({ kind: "home", path: "/home/ci" });
  expect(net.spawned.at(-1)).toBe("ace-machine-build");
});

test("a daemon that answers as another machine is refused, not used", async () => {
  // The address now reaches a different daemon than the one paired there.
  const impostor = daemon("someone-else", "build");
  const pool = browserMachinePool({
    storage: memoryKeyValue(),
    spawnWorker: network(impostor).spawnWorker,
  });
  pools.push(pool);
  await pool.start();
  await pair(pool, "build", "build");
  await status(pool, "build", "auth_failed");
  expect(() => pool.client("build")).toThrow();
});
