/**
 * Cold start of the bundled daemon on an empty home: spawn to endpoint and to the first
 * sidebar a fresh client is served, then idle memory. `--prof` adds one `--cpu-prof` start,
 * attributed to module loading versus startup work.
 *
 * node tools/daemon-bench/src/profile/startup.ts --entry=DIR/ace.mjs [--node=PATH] [--reps=5]
 *   [--maps=DIR] [--prof] [--out=DIR]
 */
import { readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { footprint, startDaemon } from "../daemon.ts";
import { Driver, until } from "../driver.ts";
import { recordings } from "../fake-cli/install.ts";
import { Inspector } from "../inspector.ts";
import { makeBenchRoot } from "../root.ts";
import { attribute } from "./attribute.ts";
import { count, option } from "./args.ts";

const entry = resolve(option("entry") ?? "");
const node = option("node");
const reps = count("reps", 5);
const out = resolve(option("out") ?? "/tmp/ace-rust-case/startup");
const maps = option("maps");
await mkdir(out, { recursive: true });
const { directory, root } = await makeBenchRoot("ace-rust-start-");
const settings = {
  entry,
  root,
  fixtures: recordings.claude,
  speed: 20,
  deltaMs: 10,
  ...(node ? { node } : {}),
};
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1] ?? 0;

/** One cold start; resolves the timings and the still-running daemon. */
async function start(execArgv: string[] = []) {
  const spawned = performance.now();
  const daemon = await startDaemon({ ...settings, execArgv });
  const endpointMs = performance.now() - spawned;
  const driver = await Driver.connect(daemon.origin, daemon.token);
  const lease = driver.client.threads();
  await until(
    lease.store.select(["ids"], (store) => store.loaded && !store.syncing),
    Boolean,
    "the sidebar",
  );
  const sidebarMs = performance.now() - spawned;
  lease.release();
  await driver.close();
  return { daemon, endpointMs, sidebarMs, load: loadavg()[0] ?? 0 };
}

try {
  // The first start lays out the home; every measured start reopens it.
  await (await startDaemon(settings)).stop();
  const runs = [];
  let idle: unknown;
  for (let rep = 0; rep < reps; rep++) {
    const { daemon, ...timing } = await start();
    runs.push(timing);
    if (rep === reps - 1) {
      await pause(10_000);
      const inspector = await Inspector.connect(daemon.inspectorUrl);
      const memory = await inspector.value(`(() => {
        const v8 = process.getBuiltinModule("node:v8");
        return { ...process.memoryUsage(), code: v8.getHeapCodeStatistics(),
          spaces: Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, s.space_used_size])) };
      })()`);
      const collected = await inspector.collected();
      idle = { memory, collected, footprint: await footprint(daemon.pid) };
      await inspector.snapshot(join(out, "idle.heapsnapshot"));
      inspector.close();
    }
    await daemon.stop();
  }
  const result: Record<string, unknown> = {
    entry,
    node: node ?? process.execPath,
    runs,
    endpointMedianMs: median(runs.map((run) => run.endpointMs)),
    sidebarMedianMs: median(runs.map((run) => run.sidebarMs)),
    idle,
  };
  if (process.argv.includes("--prof")) {
    const dir = join(out, "prof");
    await rm(dir, { recursive: true, force: true });
    const { daemon, ...timing } = await start([
      "--cpu-prof",
      `--cpu-prof-dir=${dir}`,
      "--cpu-prof-interval=250",
    ]);
    await daemon.stop();
    const files = (await readdir(dir)).filter((file) => file.endsWith(".cpuprofile"));
    // Workers write their own files; the main isolate's is the largest.
    result["profiled"] = {
      timing,
      isolates: files.length,
      main: files.length
        ? attribute(join(dir, files[0] ?? ""), maps ?? resolve(entry, ".."), 0, timing.sidebarMs)
        : undefined,
    };
  }
  await writeFile(join(out, "startup.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ endpointMedianMs: result["endpointMedianMs"], sidebarMedianMs: result["sidebarMedianMs"] })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
