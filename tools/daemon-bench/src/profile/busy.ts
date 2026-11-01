/**
 * CPU profile of the bundled daemon under a busy, realistic load, with no provider quota spent:
 * concurrent fake-CLI turns (subagents, tool calls, MCP calls, long streamed answers), several
 * connected clients that hold the sidebar and watch each running thread, and one client paging
 * and searching a long thread. The main isolate's sampler runs over exactly the busy window;
 * process CPU over the same window shows what other threads (workers, libuv) add.
 *
 * node tools/daemon-bench/src/profile/busy.ts --entry=DIR/ace.mjs --out=DIR
 *   [--node=PATH] [--lanes=4] [--cycles=4] [--observers=3] [--deltas=300]
 *   [--history-turns=30] [--seed-threads=400] [--interval-us=500] [--keep]
 *   [--mode=v8|native|plain] [--same-thread]
 *
 * Modes are separate runs so no profiler distorts another: `v8` samples JavaScript frames,
 * `native` runs macOS `sample` in 10 s chunks (SQLite, JSON, GC and thread split), and `plain`
 * measures headline CPU per event with no profiler attached.
 */
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { footprint, startDaemon, type RunningDaemon } from "../daemon.ts";
import { Driver } from "../driver.ts";
import { recordings } from "../fake-cli/install.ts";
import { Inspector } from "../inspector.ts";
import { makeBenchRoot } from "../root.ts";
import { seedThreads } from "../seed.ts";
import { option, count } from "./args.ts";
import { buildHistory, runLoad } from "./load.ts";

const entry = resolve(option("entry") ?? "");
const out = resolve(option("out") ?? "/tmp/ace-rust-case/busy");
const node = option("node");
const lanes = count("lanes", 4);
const cycles = count("cycles", 4);
const observers = count("observers", 3);
const deltas = count("deltas", 300);
const historyTurns = count("history-turns", 30);
const seeded = count("seed-threads", 400);
const intervalUs = count("interval-us", 500);
const mode = option("mode") ?? "v8";
const sameThread = process.argv.includes("--same-thread");
if (!["v8", "native", "plain"].includes(mode)) throw new Error("--mode is v8, native or plain");
const log = (line: string) => process.stderr.write(`busy: ${line}\n`);
const now = () => process.hrtime.bigint() / 1000n;

const { directory, root } = await makeBenchRoot("ace-rust-case-");
const profiles = join(out, "profiles");
await rm(out, { recursive: true, force: true });
await mkdir(profiles, { recursive: true });
const settings = {
  entry,
  root,
  fixtures: recordings.claude,
  speed: 20,
  deltaMs: 10,
  ...(node ? { node } : {}),
};
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Number(now());
};
const headSeq = () => {
  const db = new DatabaseSync(join(root.aceHome, "events.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT max(seq) AS head FROM events").get();
    return Number(row?.["head"] ?? 0);
  } finally {
    db.close();
  }
};

let daemon: RunningDaemon | undefined;
let inspector: Inspector | undefined;
const clients: Driver[] = [];
try {
  await (await startDaemon(settings)).stop();
  seedThreads(root.aceHome, join(root.home, "seeded-project"), seeded);
  mark("spawn");
  daemon = await startDaemon(settings);
  mark("endpoint");
  inspector = await Inspector.connect(daemon.inspectorUrl);
  const driver = await Driver.connect(daemon.origin, daemon.token);
  mark("firstSidebar");
  clients.push(driver);
  for (let index = 0; index < observers; index++)
    clients.push(await Driver.connect(daemon.origin, daemon.token));
  const workspace = await driver.addProject(root.project);
  await driver.createTurn(workspace, "claude", "warm up");

  log(`building a ${historyTurns}-turn thread to page through`);
  const history = await buildHistory(driver, workspace, historyTurns);
  await pause(3000);

  const calibrationBefore = await inspector.calibrate();
  const memoryBefore = await inspector.collected();
  const seqBefore = headSeq();
  const txBefore = await driver.transactions();
  const cpuBefore = await inspector.counters();
  const split = () =>
    inspector?.value(
      "(() => { const c = process.cpuUsage(); const t = process.threadCpuUsage(); return { user: c.user, system: c.system, mainUser: t.user, mainSystem: t.system }; })()",
    );
  const splitBefore = await split();
  const load = [loadavg()[0]];
  log(`busy: ${lanes} lanes x ${cycles} cycles, ${observers} observers`);
  if (mode === "v8") await inspector.profileStart(intervalUs);
  mark("busyStart");
  const state = { lanesDone: false };
  const pid = daemon.pid;
  const sampler = async () => {
    let chunk = 0;
    while (!state.lanesDone) {
      const file = join(profiles, `native-${String(chunk++).padStart(2, "0")}.txt`);
      await promisify(execFile)("/usr/bin/sample", [String(pid), "10", "1", "-file", file]);
    }
  };
  const sampling = mode === "native" ? sampler() : Promise.resolve();
  const loadTimer = setInterval(() => load.push(loadavg()[0]), 2000);
  const { pages } = await runLoad({
    driver,
    observers: clients.slice(1),
    workspace,
    history,
    lanes,
    cycles,
    deltas,
    sameThread,
  }).finally(() => {
    state.lanesDone = true;
  });
  clearInterval(loadTimer);
  mark("busyEnd");
  await sampling;
  const cpuAfter = await inspector.counters();
  const splitAfter = await split();
  if (mode === "v8") {
    const profile = await inspector.profileStop();
    await writeFile(join(profiles, "busy-main.cpuprofile"), JSON.stringify(profile));
  }
  const txAfter = await driver.transactions();
  const seqAfter = headSeq();
  const memoryAfter = await inspector.collected();
  const calibrationAfter = await inspector.calibrate();
  const physical = await footprint(daemon.pid);
  const summary = {
    node: node ?? process.execPath,
    entry,
    mode,
    workload: {
      sameThread,
      lanes,
      cycles,
      observers,
      deltas,
      historyTurns,
      seeded,
      intervalUs,
      pages,
    },
    marks,
    busy: {
      wallMs: (marks["busyEnd"]! - marks["busyStart"]!) / 1000,
      cpuMs: (cpuAfter.cpuMicros - cpuBefore.cpuMicros) / 1000,
      events: seqAfter - seqBefore,
      transactions: txAfter - txBefore,
      turns: lanes * cycles,
    },
    calibrationMs: Math.min(calibrationBefore, calibrationAfter),
    cpuSplit: { before: splitBefore, after: splitAfter },
    memory: { before: memoryBefore, after: memoryAfter, footprint: physical },
    load: {
      min: Math.min(...(load as number[])),
      median: (load as number[]).toSorted((a, b) => a - b)[load.length >> 1],
      max: Math.max(...(load as number[])),
    },
  };
  await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary.busy)} load=${JSON.stringify(summary.load)}\n`);
} finally {
  inspector?.close();
  for (const client of clients) await client.close().catch(() => {});
  await daemon?.stop();
  if (process.argv.includes("--keep")) log(`kept ${directory}`);
  else await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
