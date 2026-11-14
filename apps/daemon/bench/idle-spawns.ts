// Counts the processes the idle daemon's background loops would start in one hour: the Git lock
// sweep's process listings, Spade's service-manager reads, and the utility run's CLI probes.
// Real Git repositories and the production modules; the clock is virtual, and every process
// that would be a provider CLI or a system tool is a counting stand-in. No real provider CLI
// runs and nothing outside a fresh temporary HOME is touched.
//
//   bun apps/daemon/bench/idle-spawns.ts
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitService } from "@ace/git";
import { discoverProvider } from "@ace/provider-kit/discovery";
import { spadeProof } from "@ace/service/spade";
import { SpadeLink } from "../src/spade/link.ts";
import type { SpadeServiceState } from "../src/spade/rules.ts";

const hour = 60 * 60_000;
const home = await realpath(await mkdtemp(join(tmpdir(), "ace-idle-spawns-")));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
const run = promisify(execFile);
const result: Record<string, unknown> = {};

try {
  // Git lock sweep: three repositories, one with four linked worktrees, no lock files (idle).
  const paths: string[] = [];
  for (let index = 0; index < 3; index++) {
    const repo = join(home, `repo-${index}`);
    await run("git", ["init", "-q", "-b", "main", repo]);
    await run("git", [
      "-C",
      repo,
      "-c",
      "user.name=B",
      "-c",
      "user.email=b@ace.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    ]);
    paths.push(repo);
    if (index === 0)
      for (let tree = 0; tree < 4; tree++) {
        const path = join(home, `repo-0-wt${tree}`);
        await run("git", ["-C", repo, "worktree", "add", "-q", "-b", `t${tree}`, path]);
        paths.push(await realpath(path));
      }
  }
  let scans = 0;
  const git = new GitService({
    processRuntime: {
      gitProcesses: async () => {
        scans++;
        return [];
      },
    },
  });
  const sweeps = hour / 60_000;
  const healAll = (git as { healAll?: GitService["healAll"] }).healAll;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    if (healAll) await healAll.call(git, paths, () => {});
    else for (const path of paths) await git.heal(path).catch(() => []);
  }
  // Each listing on macOS is one lsof, plus ps runs when any Git process is alive.
  result.lockSweep = {
    workspaces: paths.length,
    sweepsPerHour: sweeps,
    processListingsPerHour: scans,
  };

  // Spade link: one hour healthy, then one hour with Spade's service stopped.
  for (const scenario of ["healthy", "down"] as const) {
    let now = 0;
    let serviceReads = 0;
    const timers: { at: number; run: () => void }[] = [];
    const token = "token-for-41-xxxxxxxx";
    const files = new Map<string, string>([
      ["/spade/token", token],
      [
        "/spade/server.json",
        JSON.stringify({ address: "127.0.0.1:4100", pid: 41, version: "0.4.0", api: 1 }),
      ],
    ]);
    const service: SpadeServiceState = scenario === "healthy" ? "running" : "stopped";
    const link = new SpadeLink({
      dataDir: "/spade",
      runtime: {
        readText: async (path) => files.get(path),
        health: async (_endpoint, nonce) =>
          scenario === "healthy"
            ? { version: "0.4.0", api: 1, proof: spadeProof(token, nonce) }
            : undefined,
        alive: () => true,
        nonce: () => "0".repeat(32),
        serviceState: async () => {
          serviceReads++;
          return service;
        },
        watch: () => () => {},
        now: () => now,
        after: (ms, callback) => {
          const timer = { at: now + ms, run: callback };
          timers.length = 0;
          timers.push(timer);
          return () => timers.splice(timers.indexOf(timer) >>> 0, 1);
        },
      },
    });
    link.setEnabled(true);
    await link.refresh();
    while (timers.length) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next || next.at > hour) break;
      now = next.at;
      // What the timer's callback does, awaited.
      await link.refresh();
    }
    await link.close();
    result[`spade_${scenario}`] = { launchctlPerHour: serviceReads };
  }

  // Utility runs: what finding the provider CLI costs per title or branch name, before the run.
  const bin = join(home, "bin");
  await mkdir(bin);
  const counter = join(home, "codex-runs");
  await writeFile(counter, "");
  const fake = join(bin, "codex");
  await writeFile(
    fake,
    `#!/bin/sh\necho run >> "${counter}"\ncase "$1" in --version) echo "codex-cli 0.200.0";; login) echo "Logged in using ChatGPT";; esac\n`,
  );
  await chmod(fake, 0o755);
  await discoverProvider("codex", {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
    signal: AbortSignal.timeout(10_000),
  });
  const probes = (await readFile(counter, "utf8")).split("\n").filter(Boolean).length;
  result.utilityDiscoveryProbesPerRun = probes;
  // With the change, a run whose CLI the provider check already found makes no probe at all.
  const known = await import("../src/utility-known-cli.ts").catch(() => undefined);
  if (known)
    result.utilityProbesWithKnownCli =
      known.knownCliPath({
        status: { runtime: "cli", installed: true, path: fake },
        binary: undefined,
        auth: "logged_in",
        needsLogin: true,
      }) === "probe"
        ? probes
        : 0;

  // Account limits: one idle hour, nothing held, no client. Before the change every five-minute
  // tick read every Codex and Claude account (one CLI process each): 12 per account per hour.
  const schedule = await import("../src/account-limits-schedule.ts").catch(() => undefined);
  if (schedule) {
    let now = 0;
    let reads = 0;
    const window = { usedPercent: 40, resetsAt: 30 * 60_000 };
    const limits = new schedule.LimitsSchedule({
      intervalMs: 5 * 60_000,
      now: () => now,
      read: async () => {
        reads++;
      },
      busy: () => false,
      quotas: () => [
        { auth: "logged_in", observedAt: 0, windows: { session: window }, blockers: {}, usage: {} },
      ],
    });
    await limits.refresh();
    reads = 0;
    for (now = 5 * 60_000; now <= hour; now += 5 * 60_000) {
      limits.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // One reading when the stored window's reset passes at minute 30.
    result.limitReadsPerAccountPerHour = { idle: reads, before: 12 };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
