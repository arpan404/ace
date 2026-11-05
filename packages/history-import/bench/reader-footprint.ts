// Idle memory of the history reader: in a worker thread (the old way) or a process of its own.
//
//   bun packages/history-import/bench/reader-footprint.ts worker|process
//
// Scans 500 small transcripts, lists them, then (after a collection) reports the daemon
// process's growth over its own baseline and the reader process's resident size, in MB: once
// while the reader is idle but alive, and once after it has retired (five idle seconds).
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { openHistory } from "../src/index.ts";

const mode = process.argv[2];
if (mode !== "worker" && mode !== "process") throw new Error("Pass worker or process");
const collect = () => {
  const runtime = globalThis as { Bun?: { gc(force: boolean): void }; gc?: () => void };
  runtime.Bun?.gc(true);
  runtime.gc?.();
};
const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
const residentOf = (pid: number) =>
  Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
const children = () => {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};

const root = await mkdtemp(join(tmpdir(), "ace-reader-footprint-"));
const project = join(root, "claude/projects/p");
await mkdir(project, { recursive: true });
for (let i = 0; i < 500; i++)
  await writeFile(
    join(project, `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111.jsonl`),
    JSON.stringify({
      type: "user",
      sessionId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      cwd: "/workspace",
      message: { role: "user", content: `prompt ${i}` },
    }) + "\n",
  );
collect();
await sleep(500);
const before = process.memoryUsage().rss;
const service = await openHistory(
  {
    indexPath: join(root, "ace/index.sqlite"),
    instances: [{ id: "claude", provider: "claude", homeDir: join(root, "claude") }],
  },
  mode === "worker" ? (url, options) => new Worker(url, options) : undefined,
);
try {
  await service.scan();
  await service.list({ type: "history.list", cwd: "/workspace", limit: 200 });
  // Idle, but within the reader's five-second retirement window.
  await sleep(1500);
  collect();
  await sleep(500);
  const measure = () => {
    const daemon = process.memoryUsage().rss - before;
    const reader = children().reduce((total, pid) => total + residentOf(pid), 0);
    return {
      daemonGrowthMb: mb(daemon),
      readerProcessMb: mb(reader),
      totalMb: mb(daemon + reader),
    };
  };
  const idle = measure();
  await sleep(6000);
  collect();
  await sleep(500);
  console.log(
    JSON.stringify({
      runtime: "bun" in process.versions ? "bun" : "node",
      mode,
      idle,
      retired: measure(),
    }),
  );
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
