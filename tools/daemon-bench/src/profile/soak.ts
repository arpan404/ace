/**
 * Memory over a long simulated session on the bundled daemon: lanes of fake-CLI turns with
 * think time, observers on every running thread, a pager on a long thread. Samples heap, RSS
 * and physical footprint, and writes main-isolate heap snapshots of this test daemon (never
 * the live one) after warm-up and at the end.
 *
 * node tools/daemon-bench/src/profile/soak.ts --entry=DIR/ace.mjs --out=DIR [--node=PATH]
 *   [--minutes=40] [--lanes=4] [--think-ms=4000] [--observers=3] [--sample-s=30]
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { footprint, startDaemon, type RunningDaemon } from "../daemon.ts";
import { Driver } from "../driver.ts";
import { recordings } from "../fake-cli/install.ts";
import { Inspector } from "../inspector.ts";
import { makeBenchRoot } from "../root.ts";
import { seedThreads } from "../seed.ts";
import { count, option } from "./args.ts";
import { buildHistory, runLoad } from "./load.ts";

const entry = resolve(option("entry") ?? "");
const out = resolve(option("out") ?? "/tmp/ace-rust-case/soak");
const node = option("node");
const minutes = count("minutes", 40);
const lanes = count("lanes", 4);
const thinkMs = count("think-ms", 4000);
const observerCount = count("observers", 3);
const sampleS = count("sample-s", 30);
const log = (line: string) => process.stderr.write(`soak: ${line}\n`);

/** Process memory, V8 heap spaces and code statistics, read inside the daemon. */
const memoryExpression = `(() => {
  const v8 = process.getBuiltinModule("node:v8");
  const spaces = Object.fromEntries(v8.getHeapSpaceStatistics().map((s) => [s.space_name, s.space_used_size]));
  return { ...process.memoryUsage(), spaces, code: v8.getHeapCodeStatistics() };
})()`;

const { directory, root } = await makeBenchRoot("ace-rust-soak-");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const settings = {
  entry,
  root,
  fixtures: recordings.claude,
  speed: 20,
  deltaMs: 10,
  ...(node ? { node } : {}),
};
let daemon: RunningDaemon | undefined;
let inspector: Inspector | undefined;
const clients: Driver[] = [];
try {
  await (await startDaemon(settings)).stop();
  seedThreads(root.aceHome, join(root.home, "seeded-project"), 400);
  daemon = await startDaemon(settings);
  const running = daemon;
  inspector = await Inspector.connect(daemon.inspectorUrl);
  const probe = inspector;
  const driver = await Driver.connect(daemon.origin, daemon.token);
  clients.push(driver);
  for (let index = 0; index < observerCount; index++)
    clients.push(await Driver.connect(daemon.origin, daemon.token));
  const workspace = await driver.addProject(root.project);
  await driver.createTurn(workspace, "claude", "warm up");
  const history = await buildHistory(driver, workspace, 20);
  await pause(5000);

  const started = performance.now();
  const sample = async (collected: boolean) => {
    if (collected) await probe.collected();
    return {
      atS: Math.round((performance.now() - started) / 1000),
      collected,
      memory: await probe.value(memoryExpression),
      footprint: await footprint(running.pid),
      cpuMicros: (await probe.counters()).cpuMicros,
      load: loadavg()[0],
    };
  };
  const series = [await sample(true)];
  await probe.snapshot(join(out, "start.heapsnapshot"));
  log(`start snapshot written; running ${minutes} min`);
  const state = { stop: false };
  const sampler = (async () => {
    let tick = 0;
    while (!state.stop) {
      await pause(sampleS * 1000);
      if (state.stop) break;
      tick++;
      // A forced collection every ten samples shows retained heap, not garbage in flight.
      series.push(await sample(tick % 10 === 0));
      await writeFile(join(out, "series.json"), JSON.stringify(series));
    }
  })();
  const load = await runLoad({
    driver,
    observers: clients.slice(1),
    workspace,
    history,
    lanes,
    cycles: Number.MAX_SAFE_INTEGER,
    untilMs: started + minutes * 60_000,
    thinkMs,
    deltas: 300,
  });
  state.stop = true;
  await sampler;
  series.push(await sample(true));
  await probe.snapshot(join(out, "end.heapsnapshot"));
  const summary = { entry, node: node ?? process.execPath, minutes, lanes, thinkMs, load, series };
  await writeFile(join(out, "series.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log(`done: ${load.turns} turns`);
} finally {
  inspector?.close();
  for (const client of clients) await client.close().catch(() => {});
  await daemon?.stop();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
