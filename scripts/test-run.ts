// Runs one test tier through Vitest, records per-file timings and checks the time budgets.
//
//   node scripts/test-run.ts full|fast|process|slow [vitest args]
//   node scripts/test-run.ts changed [--with-process] [--with-slow] [--base <ref>] [vitest args]
//
// Every run writes test-timings/last.json. A run with no extra arguments also writes
// test-timings/<tier>.json, so the latest unfiltered run of each tier is kept.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
} from "./test-tiers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = parseRunArgs(process.argv.slice(2));

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const args = ["run", ...projectsFor(options).flatMap((name) => ["--project", name])];
if (options.tier === "changed") {
  // Diff from where this branch left main, so main's own later changes don't count.
  const base = options.base ?? git("merge-base", "HEAD", "origin/main");
  console.log(`Running tests affected by changes since ${base.slice(0, 12)}`);
  args.push("--changed", base);
}
args.push(...options.vitestArgs);

const timingsDir = join(root, "test-timings");
const lastRun = join(timingsDir, "last.json");
rmSync(lastRun, { force: true });
const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const child = spawn(process.execPath, [vitestBin, ...args], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ACE_TEST_TIMINGS_FILE: lastRun },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
const exitCode = await new Promise<number>((resolve) =>
  child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0))),
);

const timingsSchema = z.object({
  files: z.array(z.object({ file: z.string(), project: z.string(), ownMs: z.number() })),
});
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
