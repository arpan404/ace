/**
 * Releases ace cloud and the market to staging or production (docs/release/workers.md): D1
 * migrations, the new version at 100%, a smoke of every hostname, and a rollback to the previous
 * version if the smoke fails. Exit codes are `exitCodes` in release.ts.
 *
 *   node tools/workers-release/src/deploy.ts <cloud|market|all> <staging|production> \
 *     [--version <tag>] [--skip-staging-check]
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and a clean checkout: the version
 * message names the commit it was built from.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { unstable_readConfig } from "wrangler";
import { parseArguments, usage, type Worker } from "./args.ts";
import { checkMigrations, migrationRoots, repositoryRoot } from "./check-migrations.ts";
import { runDeploy, type RunResult } from "./deploy-run.ts";
import { formatProblem } from "./migration-lint.ts";
import { exitCodes, releaseFor, smokeOrigins, type Environment, type Release } from "./release.ts";
import { runProcess } from "./run-process.ts";
import { wranglerWorker } from "./wrangler.ts";

const appDirectories: Record<Worker, string> = {
  cloud: join(repositoryRoot, "apps/cloud"),
  market: join(repositoryRoot, "apps/market"),
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();

/** A smoke still running after this has hung: it fails, so the release rolls back. */
const smokeDeadlineMs = 180_000;

async function smoke(cwd: string, origin: string): Promise<boolean> {
  try {
    const ran = await runProcess("node", ["scripts/smoke.ts", origin], {
      cwd,
      capture: false,
      timeoutMs: smokeDeadlineMs,
    });
    return ran.code === 0;
  } catch {
    return false;
  }
}

async function deployWorker(
  worker: Worker,
  environment: Environment,
  release: Release,
  skipStagingCheck: boolean,
): Promise<RunResult> {
  const cwd = appDirectories[worker];
  const config = unstable_readConfig(
    { config: join(cwd, "wrangler.jsonc"), env: environment },
    { hideWarnings: true },
  );
  const problems = await checkMigrations([migrationRoots[worker]]);
  const waitForStaging = environment === "production" && !skipStagingCheck;
  return runDeploy(
    {
      worker,
      environment,
      release,
      databases: config.d1_databases,
      origins: smokeOrigins(config.routes ?? []),
      migrationProblems: problems.map(formatProblem),
    },
    {
      port: wranglerWorker(runProcess, cwd, environment),
      staging: waitForStaging ? wranglerWorker(runProcess, cwd, "staging") : undefined,
      smoke: (origin) => smoke(cwd, origin),
      sleep: (ms) => sleep(ms),
      log: (line) => console.log(`[${worker} ${environment}] ${line}`),
    },
  );
}

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(`${parsed}\n${usage}`);
    return exitCodes.usage;
  }
  if (git("status", "--porcelain", "--untracked-files=no") !== "") {
    console.error("The checkout has uncommitted changes; a release deploys a commit as it is.");
    return exitCodes.unchanged;
  }
  let release: Release;
  try {
    release = releaseFor(parsed.version, git("rev-parse", "HEAD"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return exitCodes.usage;
  }
  for (const worker of parsed.workers) {
    let result: RunResult;
    try {
      result = await deployWorker(worker, parsed.environment, release, parsed.skipStagingCheck);
    } catch (error) {
      // Only the config and the reads before the deploy throw: runDeploy settles the rest.
      const message = error instanceof Error ? error.message : String(error);
      result = {
        code: exitCodes.unchanged,
        summary: `${worker} ${parsed.environment}: ${message}`,
      };
    }
    console.log(`\nRESULT ${result.code} ${result.summary}\n`);
    if (result.code !== exitCodes.deployed) return result.code;
  }
  return exitCodes.deployed;
}

process.exitCode = await main();
