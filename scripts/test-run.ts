// Runs one test tier through Vitest, records per-file timings and checks the time budgets.
//
//   node scripts/test-run.ts full|fast|process|slow [vitest args]
//   node scripts/test-run.ts changed [--with-process] [--with-slow] [--base <ref>] [vitest args]
//
// Run with bun, Vitest runs on Bun, except the suites in nodeOnlySuites (scripts/test-tiers.ts),
// which follow in a second pass on Node.
//
// Every run writes test-timings/last.json. A run with no extra arguments also writes
// test-timings/<tier>.json, so the latest unfiltered run of each tier is kept.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  budgetFailures,
  budgetMs,
  budgetTable,
  failsOnFastBudget,
  overBudget,
  parseRunArgs,
  projectsFor,
  splitByRuntime,
} from "./test-tiers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = parseRunArgs(process.argv.slice(2));

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const shared: string[] = [];
if (options.tier === "changed") {
  // Diff from where this branch left main, so main's own later changes don't count.
  const base = options.base ?? git("merge-base", "HEAD", "origin/main");
  console.log(`Running tests affected by changes since ${base.slice(0, 12)}`);
  shared.push("--changed", base);
}
shared.push(...options.vitestArgs);

const timingsDir = join(root, "test-timings");
const lastRun = join(timingsDir, "last.json");
const nodeRun = join(timingsDir, "last-node.json");
rmSync(lastRun, { force: true });
rmSync(nodeRun, { force: true });
const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const timingsSchema = z.looseObject({
  files: z.array(z.looseObject({ file: z.string(), project: z.string(), ownMs: z.number() })),
});

const projectArgs = (projects: readonly string[]) =>
  projects.flatMap((name) => ["--project", name]);
function vitest(runtime: string, args: string[], timingsFile: string): Promise<number> {
  const child = spawn(runtime, [vitestBin, "run", ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ACE_TEST_TIMINGS_FILE: timingsFile },
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, forward);
  return new Promise<number>((resolve) =>
    child.on("close", (code, signal) => {
      for (const name of ["SIGINT", "SIGTERM"] as const) process.off(name, forward);
      resolve(code ?? (signal ? 1 : 0));
    }),
  );
}

const projects = projectsFor(options);
let exitCode = 0;
if ("bun" in process.versions) {
  // Suites for code that doesn't run on Bun in production run on Node (`node` on PATH).
  const passes = splitByRuntime(projects);
  // A file filter may select only Node-only suites, leaving the Bun pass empty.
  const empty = passes.node ? ["--passWithNoTests"] : [];
  if (passes.bun)
    exitCode = await vitest(
      process.execPath,
      [...projectArgs(passes.bun), ...empty, ...shared],
      lastRun,
    );
  if (passes.node) {
    console.log("\nRunning the Node-only suites on Node");
    const nodeExit = await vitest(
      "node",
      [...projectArgs(passes.node), "--passWithNoTests", ...shared],
      nodeRun,
    );
    exitCode ||= nodeExit;
    mergeTimings(lastRun, nodeRun);
  }
} else exitCode = await vitest(process.execPath, [...projectArgs(projects), ...shared], lastRun);

/** Appends the Node pass's file timings to the main run's, so budgets see both. */
function mergeTimings(into: string, from: string) {
  if (!existsSync(from)) return;
  const extra = timingsSchema.parse(JSON.parse(readFileSync(from, "utf8")));
  rmSync(from, { force: true });
  if (!existsSync(into)) return writeFileSync(into, `${JSON.stringify(extra, null, 1)}\n`);
  const main = timingsSchema.parse(JSON.parse(readFileSync(into, "utf8")));
  writeFileSync(
    into,
    `${JSON.stringify({ ...main, files: [...main.files, ...extra.files] }, null, 1)}\n`,
  );
}

const allowlistSchema = z.object({
  fast: z.record(z.string(), z.string()),
  process: z.record(z.string(), z.string()),
});

let budgetExit = 0;
if (existsSync(lastRun)) {
  if (options.vitestArgs.length === 0 && options.tier !== "changed")
    copyFileSync(lastRun, join(timingsDir, `${options.tier}.json`));
  const timings = timingsSchema.parse(JSON.parse(readFileSync(lastRun, "utf8")));
  const allowlist = allowlistSchema.parse(
    JSON.parse(readFileSync(join(root, "scripts/test-budgets.json"), "utf8")),
  );
  // Slower machines (the Windows VM) can loosen every budget, e.g. ACE_TEST_BUDGET_SCALE=2.
  const scale = Number(process.env.ACE_TEST_BUDGET_SCALE) || 1;
  const findings = overBudget(timings.files, allowlist, scale);
  const table = budgetTable(findings);
  if (table) console.log(`\n${table}`);
  const failures = budgetFailures(findings);
  if (failsOnFastBudget(options.tier) && failures.length > 0) {
    console.error(
      `\n${failures.length} fast-tier file(s) went over the ${((budgetMs.unit ?? 0) * scale) / 1000}s budget. Make them faster, ` +
        `move real-process work to a *.process.test.ts file, or add them to ` +
        `scripts/test-budgets.json with a reason.`,
    );
    budgetExit = 1;
  }
}
process.exit(exitCode || budgetExit);
