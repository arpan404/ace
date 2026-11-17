import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { accessRequest } from "./client-access.ts";
import { readConfig, startDaemon } from "./index.ts";
import { DiskFullAtStartError } from "./sqlite-failure.ts";
import { reserveBytes } from "./storage-reserve.ts";
import { systemStorageDelay } from "./storage-watch.ts";
import { noProviderDiscovery } from "./testing/no-provider-discovery.ts";

/*
 * A daemon starting on a disk with no free block at all (ADR 0174). A real 64 MiB volume, a
 * macOS disk image, stands in for the disk: nothing else makes SQLite meet a full disk while it
 * opens its files. Levels are scaled down to fit the volume.
 */

const MiB = 1024 * 1024;
const levels = { pauseBelow: 1 * MiB, resumeAt: 2 * MiB, warnBelow: 4 * MiB };

async function volume(onFinished: (close: () => Promise<void>) => void) {
  const dir = await mkdtemp(join(tmpdir(), "ace-full-volume-"));
  const image = join(dir, "volume.dmg");
  const mount = join(dir, "mnt");
  const hdiutil = (...args: string[]) => execFileSync("hdiutil", args, { stdio: "ignore" });
  hdiutil("create", "-size", "64m", "-fs", "HFS+", "-volname", "acefull", "-layout", "NONE", image);
  hdiutil("attach", "-nobrowse", "-mountpoint", mount, image);
  onFinished(async () => {
    hdiutil("detach", "-force", mount);
    await rm(dir, { recursive: true, force: true });
  });
  const filler = join(mount, "filler");
  return {
    mount,
    /** Writes until the volume refuses even 512 bytes: ENOSPC, no block left. */
    fill() {
      const fd = openSync(filler, "a");
      try {
        for (const size of [MiB, 4096, 512]) {
          const chunk = Buffer.alloc(size);
          try {
            for (;;) writeSync(fd, chunk);
          } catch {
            /* Full at this size; try a smaller one. */
          }
        }
      } finally {
        closeSync(fd);
      }
    },
    free: () => unlinkSync(filler),
  };
}

test.skipIf(process.platform !== "darwin")(
  "a daemon started on a disk with no free block comes up with new work held, reads served, and lets work in once space is freed",
  async ({ onTestFinished }) => {
    const disk = await volume(onTestFinished);
    const home = join(disk.mount, "home");
    const config = readConfig({ ACE_HOME: home, ACE_PORT: "0" });
    const reserve = join(home, "storage-reserve");
    const start = (delay = systemStorageDelay) =>
      startDaemon({ engine: noProviderDiscovery, config, storageWatch: { levels, delay } });

    // A daemon with room keeps ace's reserve.
    await (await start()).close();
    expect(statSync(reserve).size).toBe(reserveBytes);

    // Without it (a home from before the reserve), a disk with no block left can't be opened:
    // SQLite can't make the files a WAL database needs, even to read. Said as what it is.
    unlinkSync(reserve);
    disk.fill();
    await expect(start()).rejects.toBeInstanceOf(DiskFullAtStartError);
    disk.free();
    await (await start()).close();
    expect(statSync(reserve).size).toBe(reserveBytes);

    // With it, the same full disk starts: the reserve makes room for ace's own files.
    disk.fill();
    const reads: (() => void)[] = [];
    const daemon = await start((run) => {
      reads.push(run);
      return () => {};
    });
    onTestFinished(() => daemon.close());
    expect(existsSync(reserve)).toBe(false);
    expect(daemon.maintenance.status().holds).toEqual(["storage"]);
    expect(daemon.maintenance.admit()).toBe(false);
    const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
    const token = await readFile(daemon.tokenPath, "utf8");
    expect(await accessRequest(origin, "/v1/status", { token })).toMatchObject({
      running: true,
      admission: { draining: true },
    });
    // Freeing only ace's own reserve is not room for new work: the person frees space.
    reads.shift()?.();
    expect(daemon.maintenance.status().holds).toEqual(["storage"]);

    disk.free();
    reads.shift()?.();
    expect(daemon.maintenance.status().holds).toEqual([]);
    expect(statSync(reserve).size).toBe(reserveBytes);
  },
  60_000,
);
