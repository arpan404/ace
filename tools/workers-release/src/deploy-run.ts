import {
  configProblems,
  decideStart,
  exitCodes,
  readAfterDeploy,
  stagingGate,
  type AfterDeploy,
  type ExitCode,
  type Live,
  type Release,
} from "./release.ts";

/*
 * One Worker's release (docs/release/workers.md): lint the migrations, check the config, skip if
 * this release already serves, apply D1 migrations, deploy the new version to all traffic, smoke
 * every hostname, and roll back to the previous version if the smoke fails. Everything it can't
 * control (Cloudflare, the smoke, the clock) comes in through `RunDeps`.
 */

/** A Worker on Cloudflare, in one environment. */
export interface WorkerPort {
  /** What serves traffic now. */
  live(): Promise<Live>;
  applyMigrations(binding: string): Promise<void>;
  /** Uploads this release and sends it all traffic. */
  deploy(release: Release): Promise<void>;
  rollback(versionId: string, message: string): Promise<void>;
}

export interface SmokePolicy {
  /** How long a new version gets to reach every location before the first smoke. */
  settleMs: number;
  attempts: number;
  betweenMs: number;
}

export const defaultSmokePolicy: SmokePolicy = { settleMs: 20_000, attempts: 3, betweenMs: 15_000 };

const settle = (deps: RunDeps) => (deps.policy ?? defaultSmokePolicy).settleMs;

export interface RunInput {
  worker: string;
  environment: "staging" | "production";
  release: Release;
  databases: readonly { binding: string; database_id?: string | undefined }[];
  origins: readonly string[];
  /** Problems the migration lint found for this Worker, as lines. */
  migrationProblems: readonly string[];
}

export interface RunDeps {
  port: WorkerPort;
  /** The staging Worker, when production must wait for staging to run this release. */
  staging?: WorkerPort | undefined;
  /** Whether the smoke passed against one origin. */
  smoke(origin: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  policy?: SmokePolicy;
}

export interface RunResult {
  code: ExitCode;
  summary: string;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether every origin passes, retrying the whole set a few times while a deploy propagates. */
async function healthy(
  origins: readonly string[],
  deps: RunDeps,
  settleMs: number,
): Promise<boolean> {
  const policy = deps.policy ?? defaultSmokePolicy;
  await deps.sleep(settleMs);
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    let passed = true;
    for (const origin of origins) {
      deps.log(`smoke ${origin} (attempt ${attempt}/${policy.attempts})`);
      if (!(await deps.smoke(origin))) passed = false;
    }
    if (passed) return true;
    if (attempt < policy.attempts) await deps.sleep(policy.betweenMs);
  }
  return false;
}

/** Back to the version that served before this release, then its own smoke. */
async function rollBack(
  input: RunInput,
  deps: RunDeps,
  previous: string | undefined,
  why: string,
): Promise<RunResult> {
  const name = `${input.worker} ${input.environment}`;
  if (previous === undefined)
    return {
      code: exitCodes.needsHuman,
      summary: `${name}: ${why}, and there is no earlier version to roll back to`,
    };
  deps.log(`${why}; rolling back to ${previous}`);
  try {
    await deps.port.rollback(previous, `Rollback from ${input.release.tag}: ${why}`.slice(0, 100));
  } catch (error) {
    return {
      code: exitCodes.needsHuman,
      summary: `${name}: ${why}, and the rollback to ${previous} failed: ${describe(error)}. A Durable Object class change blocks rollbacks past it.`,
    };
  }
  if (!(await healthy(input.origins, deps, settle(deps))))
    return {
      code: exitCodes.needsHuman,
      summary: `${name}: ${why}; rolled back to ${previous}, which fails its smoke too`,
    };
  return {
    code: exitCodes.rolledBack,
    summary: `${name}: ${why}; rolled back to ${previous}, which passes its smoke`,
  };
}

/**
 * What the deploy left live. "Unchanged" only when the deploy failed and the previous version
 * still serves: a deploy that reported success is re-read once (the API can lag), and if it
 * still shows the previous version it is treated as unknown and rolled back to that version. If
 * Cloudflare can't be asked, a deploy that reported success is taken as live (and smoked), one
 * that failed as unknown. Never unchanged while an unsmoked version might serve.
 */
async function afterDeploy(
  input: RunInput,
  deps: RunDeps,
  previous: string | undefined,
  deployError: string | undefined,
): Promise<AfterDeploy> {
  try {
    const first = readAfterDeploy(await deps.port.live(), previous, input.release);
    if (first.state !== "unchanged" || deployError !== undefined) return first;
    await deps.sleep(settle(deps));
    const again = readAfterDeploy(await deps.port.live(), previous, input.release);
    return again.state === "unchanged" ? { state: "unknown" } : again;
  } catch (error) {
    deps.log(`couldn't read what serves after the deploy: ${describe(error)}`);
    return deployError === undefined
      ? { state: "live", versionId: "unread" }
      : { state: "unknown" };
  }
}

export async function runDeploy(input: RunInput, deps: RunDeps): Promise<RunResult> {
  const name = `${input.worker} ${input.environment}`;
  const unchanged = (summary: string): RunResult => ({
    code: exitCodes.unchanged,
    summary: `${name}: ${summary}`,
  });

  if (input.migrationProblems.length > 0) {
    for (const line of input.migrationProblems) deps.log(line);
    return unchanged("a migration would break the running Worker (see above)");
  }
  const problems = configProblems(input.databases);
  if (problems.length > 0) {
    for (const line of problems) deps.log(line);
    return unchanged("the environment's resources aren't set up (see above)");
  }
  if (input.origins.length === 0) return unchanged("the environment has no custom domain to smoke");

  const start = decideStart(await deps.port.live(), input.release);
  if (start.action === "skip") {
    // Nothing to deploy, but a run that left this release live and failing mustn't pass now.
    if (await healthy(input.origins, deps, 0))
      return {
        code: exitCodes.deployed,
        summary: `${name}: ${input.release.tag} already serves all traffic (${start.versionId}) and passes its smoke; nothing to do`,
      };
    return {
      code: exitCodes.needsHuman,
      summary: `${name}: ${input.release.tag} already serves all traffic (${start.versionId}) but fails its smoke`,
    };
  }
  if (start.action === "refuse") return unchanged(start.reason);

  if (deps.staging) {
    const refused = stagingGate(await deps.staging.live(), input.release);
    if (refused) return unchanged(refused);
  }

  for (const db of input.databases) {
    deps.log(`apply migrations: ${db.binding}`);
    try {
      await deps.port.applyMigrations(db.binding);
    } catch (error) {
      return unchanged(`migrations for ${db.binding} failed: ${describe(error)}`);
    }
  }

  deps.log(`deploy ${input.release.message}`);
  let deployError: string | undefined;
  try {
    await deps.port.deploy(input.release);
  } catch (error) {
    deployError = describe(error);
  }
  const after = await afterDeploy(input, deps, start.previous, deployError);
  if (after.state === "unchanged")
    return unchanged(
      `the deploy didn't take: ${deployError ?? "the previous version still serves"}`,
    );
  if (after.state === "unknown")
    return rollBack(input, deps, start.previous, `the deploy left an unexpected version live`);

  if (await healthy(input.origins, deps, settle(deps)))
    return {
      code: exitCodes.deployed,
      summary: `${name}: ${input.release.tag} is live (${after.versionId}) and passes its smoke`,
    };
  return rollBack(input, deps, start.previous, `${input.release.tag} failed its smoke`);
}
