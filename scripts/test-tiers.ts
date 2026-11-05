/** Test tiers, per-file time budgets and the budget check. Pure: no I/O. */

export type Tier = "full" | "fast" | "process" | "slow" | "changed";
export const tiers: readonly Tier[] = ["full", "fast", "process", "slow", "changed"];

/** Vitest projects (see vitest.config.ts) that make up each budgeted tier. */
export const fastProjects = ["unit", "web", "client-react"] as const;
export const processProjects = ["process", "node-process"] as const;
export const slowProjects = ["slow-process", "browser-process", "history-scale"] as const;

/** Per-file budgets in milliseconds; projects not listed have no budget. */
export const budgetMs: Readonly<Record<string, number>> = {
  unit: 5_000,
  web: 5_000,
  "client-react": 5_000,
  process: 30_000,
  "node-process": 30_000,
};

/**
 * Process suites that always run on Node, also in a run on Bun (the `node-process` project).
 * Each covers code whose production runtime is not Bun.
 */
export const nodeOnlySuites = [
  // The Worker runs on Cloudflare's workerd. Wrangler's test harness refuses to forward requests
  // under Bun, whose fetch ignores the undici dispatcher Miniflare routes through.
  "apps/relay-cloudflare/src/**/*.process.test.ts",
  // The self-hosted relay server ships on Node (apps/relay/Dockerfile). Bun's built-in `ws`
  // has no fragment limit (`maxFragments`), which this suite checks the server enforces.
  "apps/relay/src/abuse.process.test.ts",
  // Their test preloads patch node:fs/promises inside the history worker. Bun's named imports of
  // builtins don't see such patches, and Bun lets nothing replace a builtin module.
  "packages/history-import/src/audit-scan.process.test.ts",
  "packages/history-import/src/observed-reads.process.test.ts",
  "packages/history-import/src/snapshot-bounds.process.test.ts",
  "packages/history-import/src/snapshot-race.process.test.ts",
  // The e2e launcher runs on Node (`node src/real-daemon.ts` in playwright.config.ts). It
  // switches HOME in-process, which Bun's os.homedir() does not follow.
  "tools/web-e2e/src/real-daemon-isolation.process.test.ts",
  // The bench's telemetry preload sees workers through Node's worker_threads diagnostics channel
  // and reaches them through inherited --import; Bun has neither.
  "apps/daemon/src/bench-telemetry.process.test.ts",
  // Its read recorder patches node:fs in every isolate (inherited --import and
  // syncBuiltinESMExports); on Bun it would see no reads, so this privacy check runs on Node.
  "apps/daemon/src/history-startup.process.test.ts",
  // The Electron main process bundles provider-kit's process code and runs it on Node, where it
  // takes koffi instead of bun:ffi and runs the probe worker on Node. These cover those paths.
  "packages/provider-kit/src/process-on-node.process.test.ts",
];
/**
 * Projects that run on Node in a run on Bun: the Node-only suites, and the web and client-react
 * jsdom projects, whose code runs in browsers (Vite builds it; Node is what its tooling runs on).
 */
export const nodeProjects: readonly string[] = ["node-process", "web", "client-react"];

/**
 * A run on Bun in two passes: Bun runs every selected project but the Node ones, then Node runs
 * the selected Node ones. `undefined` skips a pass; an empty list means every project, as in
 * projectsFor (Bun's config leaves the Node projects out).
 */
export function splitByRuntime(projects: readonly string[]): {
  bun: string[] | undefined;
  node: string[] | undefined;
} {
  if (projects.length === 0) return { bun: [], node: [...nodeProjects] };
  const bun = projects.filter((name) => !nodeProjects.includes(name));
  const node = projects.filter((name) => nodeProjects.includes(name));
  return {
    bun: bun.length ? bun : undefined,
    node: node.length ? node : undefined,
  };
}

export interface PassResult {
  exitCode: number;
  /** Test files the pass ran, from its timings. */
  files: number;
}

/**
 * The exit code of a run made of passes. Each pass may select nothing (a filter can match only
 * one runtime's suites), but a filtered run that ran no file at all fails, as Vitest does on Node:
 * a mistyped filter must not pass.
 */
export function combinedExit(passes: readonly PassResult[], filtered: boolean): number {
  const failed = passes.find((pass) => pass.exitCode !== 0);
  if (failed) return failed.exitCode;
  const files = passes.reduce((total, pass) => total + pass.files, 0);
  return filtered && files === 0 ? 1 : 0;
}

export type BudgetTier = "fast" | "process";
const budgetTier = (project: string): BudgetTier | undefined =>
  (fastProjects as readonly string[]).includes(project)
    ? "fast"
    : (processProjects as readonly string[]).includes(project)
      ? "process"
      : undefined;

export interface RunOptions {
  tier: Tier;
  /** test:changed only: also run the process tier, or every tier. */
  withProcess: boolean;
  withSlow: boolean;
  /** test:changed only: the ref to diff against (default: merge-base with origin/main). */
  base: string | undefined;
  /** Projects named with `--project`, added to the tier's; each runs on its own runtime. */
  projects: string[];
  /** Arguments passed through to `vitest run`. */
  vitestArgs: string[];
}

/** Parse `test-run.ts <tier> [--with-process] [--with-slow] [--base <ref>] [vitest args]`. */
export function parseRunArgs(argv: readonly string[]): RunOptions {
  const [first, ...rest] = argv;
  const tier = tiers.find((name) => name === first);
  if (!tier) throw new Error(`first argument must be one of: ${tiers.join(", ")}`);
  const options: RunOptions = {
    tier,
    withProcess: false,
    withSlow: false,
    base: undefined,
    projects: [],
    vitestArgs: [],
  };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? "";
    // `bun run test -- <files>` may pass the separator through; Vitest would treat what follows
    // as positional extras rather than file filters.
    if (arg === "--") continue;
    if (tier === "changed" && arg === "--with-process") options.withProcess = true;
    else if (tier === "changed" && arg === "--with-slow") options.withSlow = true;
    else if (tier === "changed" && arg === "--base") {
      options.base = rest[++index];
      if (!options.base) throw new Error("--base needs a git ref");
    } else if (arg === "--project") {
      const name = rest[++index];
      if (!name) throw new Error("--project needs a project name");
      options.projects.push(name);
    } else if (arg.startsWith("--project=")) options.projects.push(arg.slice("--project=".length));
    else options.vitestArgs.push(arg);
  }
  return options;
}

/**
 * The Vitest projects a run selects; an empty list means every project. Projects named with
 * `--project` join the tier's, as Vitest's own flag would, and go through the runner so a Bun run
 * sends each to the pass for its runtime instead of handing Bun a project its config leaves out.
 */
export function projectsFor(
  options: Pick<RunOptions, "tier" | "withProcess" | "withSlow"> & { projects?: readonly string[] },
): string[] {
  const named = options.projects ?? [];
  const tier = tierProjects(options);
  if (named.length === 0) return tier;
  return tier.length === 0 ? [...new Set(named)] : [...new Set([...tier, ...named])];
}

function tierProjects(options: Pick<RunOptions, "tier" | "withProcess" | "withSlow">): string[] {
  switch (options.tier) {
    case "full":
      return [];
    case "fast":
      return [...fastProjects];
    case "process":
      return [...processProjects];
    case "slow":
      return [...slowProjects];
    case "changed":
      return [
        ...fastProjects,
        ...(options.withProcess || options.withSlow ? processProjects : []),
        ...(options.withSlow ? slowProjects : []),
      ];
  }
}

/** Over-budget files fail the run only in the fast tier (and test:changed, which defaults to it). */
export const failsOnFastBudget = (tier: Tier) => tier === "fast" || tier === "changed";

export interface FileTiming {
  file: string;
  project: string;
  /** Tests and hooks: the file's own time, without imports or shared environment setup. */
  ownMs: number;
}

export type Allowlist = Readonly<Record<BudgetTier, Readonly<Record<string, string>>>>;

export interface BudgetFinding extends FileTiming {
  tier: BudgetTier;
  budgetMs: number;
  /** The allowlist reason, when the file is allowed to exceed its budget. */
  allowed: string | undefined;
}

/** Files over their tier's budget, slowest first. `scale` loosens budgets on slower machines. */
export function overBudget(
  timings: readonly FileTiming[],
  allowlist: Allowlist,
  scale = 1,
): BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  for (const timing of timings) {
    const tier = budgetTier(timing.project);
    const budget = budgetMs[timing.project];
    if (!tier || budget === undefined || timing.ownMs <= budget * scale) continue;
    findings.push({
      ...timing,
      tier,
      budgetMs: budget * scale,
      allowed: allowlist[tier][timing.file],
    });
  }
  return findings.toSorted((a, b) => b.ownMs - a.ownMs);
}

/** Fast-tier files over budget and not on the allowlist: these fail test:fast. */
export const budgetFailures = (findings: readonly BudgetFinding[]) =>
  findings.filter((finding) => finding.tier === "fast" && finding.allowed === undefined);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A short table of over-budget files; allowlisted ones are counted, not listed. */
export function budgetTable(findings: readonly BudgetFinding[]): string {
  const listed = findings.filter((finding) => finding.allowed === undefined);
  const allowed = findings.length - listed.length;
  const lines = listed.map(
    (finding) =>
      `  ${seconds(finding.ownMs).padStart(7)}  > ${seconds(finding.budgetMs).padEnd(6)} ${finding.tier.padEnd(8)} ${finding.file}`,
  );
  if (allowed > 0)
    lines.push(`  (${allowed} more over budget, allowlisted in scripts/test-budgets.json)`);
  if (lines.length === 0) return "";
  return [`Test files over their time budget:`, ...lines].join("\n");
}
