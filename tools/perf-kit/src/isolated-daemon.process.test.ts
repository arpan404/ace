import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startBenchDaemon } from "@ace/perf-kit/daemon";

/*
 * Real child processes: whether the launcher returns and cleans up depends on how a forked
 * runtime reports its exit, which a unit test of the bookkeeping cannot show.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function entry(source: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-isolated-daemon-test-"));
  roots.push(root);
  const homes = join(root, "homes");
  await writeFile(join(root, "entry.mjs"), source);
  await mkdir(homes);
  return { file: join(root, "entry.mjs"), homes };
}

test("a daemon that crashes on start is reported and leaves no home behind", async () => {
  const { file, homes } = await entry(`throw new Error("broken on start");`);
  await expect(
    startBenchDaemon({
      entry: file,
      execPath: process.execPath,
      parse: (ready) => ready,
      root: homes,
    }),
  ).rejects.toThrow(/exited/);
  expect(await readdir(homes)).toEqual([]);
});

test("closing a daemon that has already exited returns and removes its home", async () => {
  const { file, homes } = await entry(
    `process.send({ id: 0, ready: true }); setTimeout(() => process.exit(0), 50);`,
  );
  const daemon = await startBenchDaemon({
    entry: file,
    execPath: process.execPath,
    parse: (ready) => ready,
    root: homes,
  });
  expect(await readdir(homes)).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await daemon.close();
  expect(await readdir(homes)).toEqual([]);
});
