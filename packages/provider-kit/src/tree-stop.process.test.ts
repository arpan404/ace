import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { spawnSupervised } from "./process.ts";
import { aliveNow, ended, withoutJob } from "./testing/cmd-shim.ts";
import { stopTreeAfterEof } from "./tree-stop.ts";

/*
 * Windows, with the kill-on-close job refused: a leader that ends itself on stdin EOF while a
 * child it started keeps running. Without the recorded tree that child would be orphaned.
 */
const windows = process.platform === "win32";
const Pids = z.object({ leader: z.number().int().positive(), child: z.number().int().positive() });
const dirs: string[] = [];
const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0))
    try {
      process.kill(pid);
    } catch {
      /* Already gone. */
    }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function orphaningLeader() {
  const dir = await mkdtemp(join(tmpdir(), "ace-tree-stop-"));
  dirs.push(dir);
  const pids = join(dir, "pids.json");
  const script = join(dir, "leader.mjs");
  await writeFile(
    script,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {',
      '  stdio: "ignore",',
      "  windowsHide: true,",
      "});",
      "child.unref();",
      `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ leader: process.pid, child: child.pid }));`,
      'process.stdout.write("ready\\n");',
      "process.stdin.resume();",
      'process.stdin.on("end", () => process.exit(0));',
      "",
    ].join("\n"),
  );
  const proc = spawnSupervised(
    withoutJob({ command: process.execPath, args: [script], env: {}, name: "tree-stop-test" }),
  );
  await new Promise<void>((resolve) => proc.stdout.once("line", () => resolve()));
  const tree = Pids.parse(JSON.parse(await readFile(pids, "utf8")));
  strays.push(tree.child);
  return { proc, tree };
}

test.runIf(windows)(
  "without a job, a leader ending on EOF leaves its child running after a plain stop",
  async () => {
    const { proc, tree } = await orphaningLeader();
    proc.stdin.end();
    expect(await proc.stop({ graceMs: 5_000 })).toMatchObject({ code: 0 });
    // The failure the recorded tree prevents: the child outlived its leader's stop.
    expect(aliveNow(tree.child)).toBe(true);
  },
);

test.runIf(windows)(
  "without a job, the child of a leader ending on EOF is dead when the tree stop resolves",
  async () => {
    const { proc, tree } = await orphaningLeader();
    expect(aliveNow(tree.child)).toBe(true);
    const started = performance.now();
    expect(await stopTreeAfterEof(proc, 30_000)).toMatchObject({ code: 0 });
    expect(aliveNow(tree.child)).toBe(false);
    expect(aliveNow(tree.leader)).toBe(false);
    // The leader ended itself on EOF; the 30 s polite grace was never waited out.
    expect(performance.now() - started).toBeLessThan(15_000);
  },
);

test.runIf(windows)(
  "a host ending its own descendants before exiting leaves none behind",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ace-tree-stop-self-"));
    dirs.push(dir);
    const pids = join(dir, "pids.json");
    const script = join(dir, "host.mjs");
    const treeStop = new URL("./tree-stop.ts", import.meta.url).href;
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const { endDescendantsSync } = await import(${JSON.stringify(treeStop)});`,
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {',
        '  stdio: "ignore",',
        "  windowsHide: true,",
        "});",
        `writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ leader: process.pid, child: child.pid }));`,
        "endDescendantsSync();",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const proc = spawnSupervised(
      withoutJob({ command: process.execPath, args: [script], env: {}, name: "tree-stop-self" }),
    );
    expect(await proc.exited).toMatchObject({ code: 0 });
    const tree = Pids.parse(JSON.parse(await readFile(pids, "utf8")));
    strays.push(tree.child);
    expect(await ended(tree.child, 0)).toBe(true);
  },
);
