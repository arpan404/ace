import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { promisify } from "node:util";
import { footprint, startDaemon, type BenchRoot, type RunningDaemon } from "./daemon.ts";
import { Driver } from "./driver.ts";
import { installFakeCli, recordings } from "./fake-cli/install.ts";
import { Inspector } from "./inspector.ts";
import { BenchResult, type Phase } from "./result.ts";
import { seedThreads } from "./seed.ts";
import {
  fixtureDigests,
  standardOptions,
  workloadVersion,
  type WorkloadOptions,
} from "./workload.ts";

const repo = resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const option = (name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const count = (name: string, fallback: number) => {
  const value = option(name);
  const parsed = Number(value);
  if (value === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a count`);
  return parsed;
};
const options: WorkloadOptions = {
  seedThreads: count("seed-threads", standardOptions.seedThreads),
  settleMs: count("settle-ms", standardOptions.settleMs),
  idleMs: count("idle-ms", standardOptions.idleMs),
  newThreads: count("new-threads", standardOptions.newThreads),
  sameThreadTurns: count("same-thread-turns", standardOptions.sameThreadTurns),
  longTextTurns: count("long-text-turns", standardOptions.longTextTurns),
  longTextDeltas: count("long-text-deltas", standardOptions.longTextDeltas),
  deltaMs: count("delta-ms", standardOptions.deltaMs),
  speed: count("speed", standardOptions.speed),
};
const log = (line: string) => process.stderr.write(`daemon bench: ${line}\n`);

async function bundle(directory: string): Promise<string> {
  const given = option("entry");
  if (given) return resolve(given);
  const output = join(directory, "bundle");
  log("bundling the daemon");
  await promisify(execFile)(
    process.execPath,
    [join(repo, "apps/daemon/bench/compile.ts"), "--cli", `--output=${output}`],
    { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
  );
  return join(output, "ace.mjs");
}

/** Projects are git repositories; git is the one real tool beside the fake CLI on PATH. */
async function project(root: BenchRoot) {
  const run = promisify(execFile);
  const { stdout } = await run("/bin/sh", ["-c", "command -v git"]);
  await symlink(stdout.trim(), join(root.bin, "git"));
  const env = { PATH: root.bin, HOME: root.home, GIT_CONFIG_NOSYSTEM: "1" };
  await writeFile(join(root.project, "README.md"), "# Benchmark project\n");
  const git = (...args: string[]) => run("git", args, { cwd: root.project, env });
  await git("init", "--quiet", "--initial-branch=main");
  await git("add", ".");
  await git(
    "-c",
    "user.name=bench",
    "-c",
    "user.email=bench@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Start",
  );
}

async function memory(inspector: Inspector, daemon: RunningDaemon) {
  const { heapUsed, rss } = await inspector.collected();
  const physical = await footprint(daemon.pid);
  return { heapUsed, rss, ...(physical === undefined ? {} : { footprint: physical }) };
}

async function phase(
  name: string,
  turns: number,
  context: { inspector: Inspector; daemon: RunningDaemon; driver: Driver },
  turn: (index: number) => Promise<void>,
): Promise<Omit<Phase, "cpuPerTurn">> {
  const { inspector, daemon, driver } = context;
  log(`${name}: ${turns} turns`);
  const transactions = await driver.transactions();
  const before = await inspector.counters();
  const started = performance.now();
  for (let index = 0; index < turns; index++) await turn(index);
  const wallMs = performance.now() - started;
  const after = await inspector.counters();
  const committed = (await driver.transactions()) - transactions;
  return {
    turns,
    wallMs: Math.round(wallMs),
    cpuMsPerTurn: (after.cpuMicros - before.cpuMicros) / 1000 / turns,
    transactionsPerTurn: committed / turns,
    memory: await memory(inspector, daemon),
  };
}

// The daemon refuses projects in system folders, and macOS temp lives under /var.
const base = process.platform === "darwin" ? "/tmp" : tmpdir();
const directory = await mkdtemp(join(base, "ace-daemon-bench-"));
const root: BenchRoot = {
  home: join(directory, "home"),
  aceHome: join(directory, "home/.ace-bench"),
  bin: join(directory, "bin"),
  project: join(directory, "home/project"),
  tmp: join(directory, "tmp"),
};
let daemon: RunningDaemon | undefined;
let driver: Driver | undefined;
let inspector: Inspector | undefined;
try {
  for (const path of [root.aceHome, root.project, root.tmp]) await mkdir(path, { recursive: true });
  await installFakeCli(root.bin, "claude");
  await project(root);
  const settings = {
    entry: await bundle(directory),
    root,
    fixtures: recordings.claude,
    speed: options.speed,
    deltaMs: options.deltaMs,
  };
  if (options.seedThreads > 0) {
    // A first start lays out the home and its schema; history is then written while stopped.
    await (await startDaemon(settings)).stop();
    log(`seeding ${options.seedThreads} threads`);
    seedThreads(root.aceHome, join(root.home, "seeded-project"), options.seedThreads);
  }
  daemon = await startDaemon(settings);
  inspector = await Inspector.connect(daemon.inspectorUrl);
  driver = await Driver.connect(daemon.origin, daemon.token);
  const workspace = await driver.addProject(root.project);
  log(`settling for ${options.settleMs} ms`);
  await pause(options.settleMs);
  const calibrations = [await inspector.calibrate()];
  const startup = await memory(inspector, daemon);

  log(`idle for ${options.idleMs} ms`);
  const idleStart = await inspector.counters();
  const idleStarted = performance.now();
  await pause(options.idleMs);
  const idleEnd = await inspector.counters();
  const idleSeconds = (performance.now() - idleStarted) / 1000;
  const idleCpuMs = (idleEnd.cpuMicros - idleStart.cpuMicros) / 1000;
  const idleMemory = await memory(inspector, daemon);

  const context = { inspector, daemon, driver };
  const active = driver;
  // The first turn pays one-time provider discovery; keep it out of every phase.
  await active.createTurn(workspace, "claude", "warm up");
  const newThreads = await phase("new threads", options.newThreads, context, (index) =>
    active.createTurn(workspace, "claude", `new thread ${index}`).then(() => undefined),
  );
  const longThread = await active.createTurn(workspace, "claude", "first turn");
  const watched = active.watch(longThread);
  const sameThread = await phase("same thread", options.sameThreadTurns, context, (index) =>
    watched.send(`turn ${index}`),
  );
  watched.release();
  const longText = await phase("long text", options.longTextTurns, context, (index) =>
    active
      .createTurn(workspace, "claude", `long answer ${index} text-deltas=${options.longTextDeltas}`)
      .then(() => undefined),
  );
  calibrations.push(await inspector.calibrate());
  const calibrationMs = Math.min(...calibrations);
  const normalize = (value: Omit<Phase, "cpuPerTurn">): Phase => ({
    ...value,
    cpuPerTurn: value.cpuMsPerTurn / calibrationMs,
  });
  const result = BenchResult.parse({
    version: 2,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    workload: {
      version: workloadVersion,
      options,
      fixtures: await fixtureDigests(recordings.claude),
    },
    calibrationMs,
    startup,
    idle: {
      seconds: idleSeconds,
      cpuPercent: (idleCpuMs / (idleSeconds * 1000)) * 100,
      cpuPerMinute: ((idleCpuMs / idleSeconds) * 60) / calibrationMs,
      memory: idleMemory,
    },
    phases: {
      newThreads: normalize(newThreads),
      sameThread: normalize(sameThread),
      longText: normalize(longText),
    },
  });
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const output = option("output");
  if (output) await writeFile(resolve(output), text);
  process.stdout.write(text);
} finally {
  inspector?.close();
  await driver?.close().catch(() => {});
  await daemon?.stop();
  if (argv.includes("--keep")) log(`kept ${directory}`);
  else await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
