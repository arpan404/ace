#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { build, type BuildOptions, type Metafile } from "esbuild";
import { appEnvironment, desktop, electronBinary, electronBundles, repo } from "./common.ts";
import { serveTestPage } from "./measure/browser-page.ts";
import { table } from "./measure/report.ts";
import type { Sample } from "./measure/sample.ts";
import type { ScenarioConfig } from "./measure/scenario.ts";

/**
 * `bun run --filter @ace/desktop measure:memory`: launches the real desktop app (main and
 * preload bundled as for release, the renderer served from `app://ace/`, the fake daemon) and
 * reports resident memory and CPU per process group across the phases a long-running app
 * goes through: idle, hidden, minimised, the embedded browser open, hidden and closed, many
 * browser sessions, and the web app's endless agent streaming at 5,000 events/s
 * (`vite --mode perf`). Each scenario runs inside the app's main process
 * (`scripts/measure/entry.ts`), so no debugger skews the numbers. Opt-in only; never in CI.
 *
 * Options: --hidden <s> (45) --stream <s> (20) --settle <s> (10) --startup-runs <n> (5)
 * --churn <n> (20) --scenarios startup,lifecycle,streaming (all; `browser` runs only the
 * embedded-browser part of lifecycle) --skip-renderer (reuse the last renderer builds)
 * --json <file>.
 */
const { values: args } = parseArgs({
  options: {
    json: { type: "string" },
    hidden: { type: "string", default: "45" },
    stream: { type: "string", default: "20" },
    settle: { type: "string", default: "10" },
    "startup-runs": { type: "string", default: "5" },
    churn: { type: "string", default: "20" },
    scenarios: { type: "string", default: "startup,lifecycle,streaming" },
    "skip-renderer": { type: "boolean", default: false },
  },
});
const log = (message: string) => console.log(`[measure] ${message}`);
const out = join(desktop, "dist/measure");

/** Main (through the measurement entry) and preload, as `electronBundles` builds them. */
async function bundle(outdir: string): Promise<string> {
  const [main, ...rest] = electronBundles(outdir, process.env);
  if (!main) throw new Error("No main bundle");
  const entry = join(desktop, "scripts/measure/entry.ts");
  const points = main.entryPoints;
  const measured: BuildOptions =
    points && !Array.isArray(points)
      ? { ...main, entryPoints: { ...points, main: entry } }
      : { ...main, entryPoints: [entry] };
  const [result] = await Promise.all([
    build({ ...measured, metafile: true }),
    ...rest.map((options) => build(options)),
  ]);
  const output = Object.entries(result.metafile.outputs).find(
    ([, value]) => value.entryPoint && resolve(value.entryPoint) === entry,
  );
  if (!output) throw new Error("The measurement entry produced no output");
  return resolve(output[0]);
}

/** The shipped main bundle: every file, and what loads before any dynamic import. */
async function mainBundleSize(): Promise<{ totalKb: number; initialKb: number; files: number }> {
  const [main] = electronBundles(join(out, "size"), process.env);
  if (!main) throw new Error("No main bundle");
  const { metafile } = await build({ ...main, metafile: true, write: false });
  const outputs: Metafile["outputs"] = metafile.outputs;
  const code = Object.keys(outputs).filter((path) => !path.endsWith(".map"));
  const initial = new Set<string>();
  const visit = (path: string) => {
    if (initial.has(path)) return;
    initial.add(path);
    for (const imported of outputs[path]?.imports ?? [])
      if (imported.kind !== "dynamic-import" && outputs[imported.path]) visit(imported.path);
  };
  // Lazily imported chunks are entry points too; start from the app's own.
  const entry = code.find((path) => outputs[path]?.entryPoint?.endsWith("src/main/index.ts"));
  if (entry) visit(entry);
  const kb = (paths: Iterable<string>) =>
    [...paths].reduce((sum, path) => sum + (outputs[path]?.bytes ?? 0), 0) / 1024;
  return { totalKb: kb(code), initialKb: kb(initial), files: code.length };
}

function renderer(mode: "fake" | "perf", outdir: string): void {
  execFileSync(
    "bun",
    ["x", "vite", "build", "--mode", mode, "--outDir", join(outdir, "renderer"), "--emptyOutDir"],
    { cwd: join(repo, "apps/web"), stdio: ["ignore", "ignore", "inherit"] },
  );
}

interface Run {
  samples: Sample[];
  marks: Record<string, number> | undefined;
  streamingRate: number | undefined;
}

/** Launches the app on one scenario and collects what it reports. */
async function run(mainFile: string, config: ScenarioConfig): Promise<Run> {
  const userData = await mkdtemp(join(tmpdir(), "ace-measure-"));
  const result: Run = { samples: [], marks: undefined, streamingRate: undefined };
  const child = spawn(await electronBinary(), [mainFile], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...appEnvironment(process.env),
      ACE_DESKTOP_DAEMON: "fake",
      ACE_DESKTOP_USER_DATA: userData,
      ACE_DESKTOP_RENDERER_URL: "",
      ACE_MEASURE: JSON.stringify(config),
    },
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let failure: string | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.startsWith("ACE_MEASURE ")) continue;
    const message = JSON.parse(line.slice("ACE_MEASURE ".length)) as {
      sample?: Sample;
      marks?: Record<string, number>;
      streamingRate?: number;
      error?: string;
    };
    if (message.sample) {
      result.samples.push(message.sample);
      log(`${message.sample.phase}: ${message.sample.total.mb.toFixed(1)} MB in total`);
    }
    if (message.marks) result.marks = message.marks;
    if (message.streamingRate !== undefined) result.streamingRate = message.streamingRate;
    if (message.error) failure = message.error;
  }
  await exited;
  await rm(userData, { recursive: true, force: true });
  if (failure) throw new Error(`The ${config.scenario} scenario failed: ${failure}`);
  return result;
}

const fakeDir = join(out, "fake");
const perfDir = join(out, "perf");
log("building main, preload and renderers");
const [fakeMain, perfMain] = await Promise.all([bundle(fakeDir), bundle(perfDir)]);
if (!args["skip-renderer"]) {
  renderer("fake", fakeDir);
  renderer("perf", perfDir);
}
const size = await mainBundleSize();
const testPage = await serveTestPage();
const config: ScenarioConfig = {
  scenario: "startup",
  hiddenMs: Number(args.hidden) * 1_000,
  streamMs: Number(args.stream) * 1_000,
  settleMs: Number(args.settle) * 1_000,
  churn: Number(args.churn),
  pageUrl: testPage.url,
};

const scenarios = new Set(args.scenarios.split(","));
const skipped = (): Run => ({ samples: [], marks: undefined, streamingRate: undefined });
const startups: Record<string, number>[] = [];
if (scenarios.has("startup")) {
  log("startup");
  for (let index = 0; index < Number(args["startup-runs"]); index++) {
    const marks = (await run(fakeMain, config)).marks;
    if (marks) startups.push(marks);
  }
}
log("lifecycle (fake daemon)");
const lifecycle = scenarios.has("lifecycle")
  ? await run(fakeMain, { ...config, scenario: "lifecycle" })
  : skipped();
if (scenarios.has("browser") && !scenarios.has("lifecycle")) {
  log("embedded browser (fake daemon)");
  lifecycle.samples.push(...(await run(fakeMain, { ...config, scenario: "browser" })).samples);
}
log("streaming (perf build)");
const streaming = scenarios.has("streaming")
  ? await run(perfMain, { ...config, scenario: "streaming" })
  : skipped();
await testPage.close();

const samples = [...lifecycle.samples, ...streaming.samples];
const median = (name: string) =>
  startups.map((marks) => marks[name] ?? Number.NaN).toSorted((a, b) => a - b)[
    Math.floor(startups.length / 2)
  ] ?? Number.NaN;
const startupLine = ["evaluated", "ready", "windowShown", "rendererLoaded", "shellVisible"]
  .map((name) => `${name} ${median(name).toFixed(0)}`)
  .join(", ");
console.log("\nResident memory (MB) per process group; CPU in % of one core over each phase\n");
console.log(table(samples));
console.log(
  `\nStartup, median of ${startups.length} runs, ms since the main process started: ${startupLine}`,
);
console.log(
  `Main bundle: ${size.totalKb.toFixed(0)} KB in ${size.files} file(s), ${size.initialKb.toFixed(0)} KB loaded at startup`,
);
console.log(`Streaming rate: ${(streaming.streamingRate ?? 0).toFixed(0)} events/s`);
if (args.json) {
  await writeFile(
    args.json,
    JSON.stringify(
      { samples, startups, mainBundle: size, streamingRate: streaming.streamingRate },
      null,
      2,
    ),
  );
  log(`wrote ${args.json}`);
}
