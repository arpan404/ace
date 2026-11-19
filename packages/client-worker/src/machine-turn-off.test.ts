import { expect, test } from "vitest";
import { MachineDirectory } from "@ace/client/machines";
import { HostId } from "@ace/protocol";
import { MachinePool, type MachineWorker } from "./machines.ts";

const scheduler = { set: () => () => {} };

test("turning a machine off while its credential is still loading starts no worker and never reconnects", async () => {
  let raw: string | null = null;
  const tokens = new Map<string, string>();
  let release: (() => void) | undefined;
  const loading = new Promise<void>((resolve) => (release = resolve));
  let hold = false;
  const directory = new MachineDirectory(
    {
      load: async () => raw,
      save: async (value) => {
        raw = value;
      },
    },
    {
      // The keychain is slow to answer once the machine starts connecting.
      get: async (key) => {
        if (hold) await loading;
        return tokens.get(key) ?? null;
      },
      set: async (key, value) => void tokens.set(key, value),
      delete: async (key) => void tokens.delete(key),
    },
  );
  const spawned: string[] = [];
  const pool = new MachinePool({
    directory,
    remote: { scheduler },
    spawn(entry): MachineWorker {
      spawned.push(entry.hostId);
      throw new Error("A turned-off machine must not start a worker");
    },
  });
  await pool.start();
  hold = true;
  await pool.add({
    identity: { hostId: HostId.parse("build"), displayName: "build", version: "fake" },
    target: { kind: "direct", url: "ws://build.test/" },
    deviceId: "device",
    token: "a".repeat(64),
  });
  pool.turnOff("build");
  release?.();
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(spawned).toEqual([]);
  expect(pool.machine("build")?.status).toBe("off");
  await pool.close();
});
