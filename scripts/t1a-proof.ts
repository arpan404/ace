// SPDX-License-Identifier: Apache-2.0
/**
 * The transport's proof run (ADR 0226, T1a.8): every test file that starts a server, run twice,
 * once with `ACE_TRANSPORT` off and once with the Rust loopback listener on, one file at a time.
 *
 * The list comes from `list-server-tests.ts`. Each leg writes a Vitest JSON report and the on leg
 * a fresh `ACE_TRANSPORT_EVIDENCE` file; a report is read with `JSON.parse(readFileSync(...))`,
 * never `require`. Every test of both legs is recorded per test. The on leg is `native` only when
 * it executed a test and the evidence file is non-empty. A skipped test in a file with no
 * identified platform guard is a failure, so one guard can't hide an unrelated skip.
 *
 * Runs with `node scripts/t1a-proof.ts`. It exits non-zero on any failed leg, a report missing,
 * unparsable or empty, an on leg with no evidence, or a skip without a platform guard. Before
 * each file it waits up to two minutes for the shared machine's 1-minute load average to fall
 * under 60, then runs anyway: this run proves pass/fail and evidence, not timing. A leg that
 * failed only by timing out is rerun once, alone, and the table says so.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { listServerTests } from "./list-server-tests.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

type Leg = "off" | "on";

/** One test's result, as the report gives it. */
interface Result {
  file: string;
  fullName: string;
  leg: Leg;
  status: string;
  message?: string;
}

interface LegRun {
  /** The report was missing, unparsable, or held no test. */
  noReport: string | undefined;
  results: Result[];
  /** The Vitest process's own exit status and output, for a failure's diagnosis. */
  status: number | null;
  output: string;
}

interface FileRun {
  file: string;
  off: LegRun;
  on: LegRun;
  /** How the on leg proved itself: `native`, `NONE`, `platform-skipped`, or why not. */
  evidence: "native" | "NONE" | "platform-skipped" | "no-report";
  /** A leg that failed only by timing out was rerun once alone. */
  rerun: { off: boolean; on: boolean };
  /** The file has a `runIf`/`skipIf` guard on the platform, so its skips are expected. */
  platformGuard: boolean;
  /** The file guards a case on the transport switch: that skip is expected on the off leg. */
  switchGuard: boolean;
}

const REPORT_TIMEOUT_MS = 15 * 60 * 1000;
/** The proof run's worker bound on this shared machine. */
const MAX_WORKERS = 2;
/** How long one file may wait for the load to settle before it runs anyway. */
const LOAD_WAIT_MS = 2 * 60 * 1000;

/** A blocking sleep; the proof run holds the shared machine between runs. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The 1-minute load average, or 0 where the platform has no such reading. */
function oneMinuteLoad(): number {
  if (process.platform === "darwin") {
    const read = spawnSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" });
    const match = /^\{\s*([\d.]+)/.exec(read.stdout ?? "");
    if (match?.[1] !== undefined) return Number(match[1]);
    return 0;
  }
  if (process.platform === "linux") return loadavg()[0] ?? 0;
  return 0;
}

/**
 * Holds until the 1-minute load average is under 60, checking every 30 s for at most two minutes,
 * then runs anyway: the machine is shared, other threads keep the load high, and this run proves
 * pass/fail rather than timing.
 */
function waitForLoad(): void {
  const deadline = Date.now() + LOAD_WAIT_MS;
  for (;;) {
    const load = oneMinuteLoad();
    if (load < 60 || Date.now() >= deadline) return;
    sleep(30_000);
  }
}

/**
 * Names the file derives from `process.platform` (a guard's constant, such as
 * `const windows = process.platform === "win32"`), so a `runIf(windows)` counts as identified.
 */
function platformConstants(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*process\.platform/g,
  )) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/** Whether a file guards a case on `transportParts()`: its off-leg skip is the switch, not a hole. */
function hasSwitchGuard(text: string): boolean {
  return /\.(?:runIf|skipIf)\s*\([^)]*transportParts\(/.test(text);
}

/** Whether a file identifies a skip as a platform guard rather than an unexplained one. */
function hasPlatformGuard(text: string): boolean {
  const names = platformConstants(text);
  for (const match of text.matchAll(/\.(?:runIf|skipIf)\s*\(([^)]*)/g)) {
    const condition = match[1] ?? "";
    if (condition.includes("process.platform")) return true;
    if (names.some((name) => new RegExp(`\\b${name}\\b`).test(condition))) return true;
  }
  return false;
}

/** What the evidence file says: `native` needs a line; an absent or empty file says nothing. */
function evidenceOf(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/** Whether a leg failed only because a test timed out, so one rerun alone is the fair reading. */
function timedOutOnly(run: LegRun): boolean {
  const failed = run.results.filter((result) => result.status === "failed");
  return (
    run.noReport === undefined &&
    failed.length > 0 &&
    failed.every((result) => /timed out in \d+ ?ms/i.test(result.message ?? ""))
  );
}

/** One leg's outcome, from its report only. */
function runLeg(file: string, leg: Leg, reportPath: string, evidencePath: string): LegRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (leg === "off") {
    delete env.ACE_TRANSPORT;
    delete env.ACE_TRANSPORT_EVIDENCE;
    delete env.ACE_TRANSPORT_ADDON;
  } else {
    env.ACE_TRANSPORT = "native";
    env.ACE_TRANSPORT_EVIDENCE = evidencePath;
  }
  const run = spawnSync(
    "bun",
    [
      "--bun",
      "x",
      "vitest",
      "run",
      file,
      `--maxWorkers=${MAX_WORKERS}`,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    { cwd: root, env, encoding: "utf8", timeout: REPORT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (!existsSync(reportPath))
    return { noReport: "missing", results: [], status: run.status, output };
  let decoded: unknown;
  try {
    const text = readFileSync(reportPath, "utf8");
    if (text.trim() === "") return { noReport: "empty", results: [], status: run.status, output };
    decoded = JSON.parse(text);
  } catch {
    return { noReport: "unparsable", results: [], status: run.status, output };
  }
  const parsed = decoded as {
    numTotalTests?: unknown;
    testResults?: {
      name?: unknown;
      assertionResults?: {
        fullName?: unknown;
        status?: unknown;
        failureMessages?: unknown;
      }[];
    }[];
  };
  if (parsed.numTotalTests === 0)
    return { noReport: "empty", results: [], status: run.status, output };
  const results: Result[] = [];
  for (const suite of parsed.testResults ?? []) {
    const suiteFile = typeof suite.name === "string" ? suite.name : file;
    for (const assertion of suite.assertionResults ?? []) {
      const status = typeof assertion.status === "string" ? assertion.status : "unknown";
      const messages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter((entry): entry is string => typeof entry === "string")
        : [];
      results.push({
        file: suiteFile,
        fullName: typeof assertion.fullName === "string" ? assertion.fullName : "",
        leg,
        status,
        ...(messages.length ? { message: messages.join("\n").slice(0, 600) } : {}),
      });
    }
  }
  if (!results.length) return { noReport: "empty", results: [], status: run.status, output };
  return { noReport: undefined, results, status: run.status, output };
}

function main(): number {
  const files = listServerTests();
  const work = mkdtempSync(join(tmpdir(), "t1a-proof-"));
  const runs: FileRun[] = [];
  const started = Date.now();
  try {
    for (const [index, file] of files.entries()) {
      waitForLoad();
      const name = `${index}`;
      let off = runLeg(file, "off", join(work, `${name}-off.json`), "");
      const evidencePath = join(work, `${name}-evidence.jsonl`);
      let on = runLeg(file, "on", join(work, `${name}-on.json`), evidencePath);
      // A leg that failed only by timing out gets one more run, alone, on a fresh report.
      let rerunOff = false;
      let rerunOn = false;
      if (timedOutOnly(off)) {
        rerunOff = true;
        off = runLeg(file, "off", join(work, `${name}-off-retry.json`), "");
      }
      if (timedOutOnly(on)) {
        rerunOn = true;
        on = runLeg(file, "on", join(work, `${name}-on-retry.json`), `${evidencePath}.retry`);
      }
      const text = readFileSync(join(root, file), "utf8");
      const platformGuard = hasPlatformGuard(text);
      const witness = rerunOn ? `${evidencePath}.retry` : evidencePath;
      const ran =
        on.noReport === undefined &&
        on.results.some((result) => result.status === "passed" || result.status === "failed");
      const evidence: FileRun["evidence"] =
        on.noReport !== undefined
          ? "no-report"
          : !ran
            ? platformGuard
              ? "platform-skipped"
              : "no-report"
            : evidenceOf(witness)
              ? "native"
              : "NONE";
      const run: FileRun = {
        file,
        off,
        on,
        evidence,
        rerun: { off: rerunOff, on: rerunOn },
        platformGuard,
        switchGuard: hasSwitchGuard(text),
      };
      runs.push(run);
      const offFailed = off.results.filter((result) => result.status === "failed").length;
      const onFailed = on.results.filter((result) => result.status === "failed").length;
      console.log(
        `[${String(index + 1).padStart(3)}/${files.length}] ` +
          `off ${(off.noReport ?? "PASS").padEnd(10)} ${off.results.length - offFailed}/${off.results.length}  ` +
          `on ${on.evidence === "native" ? "native" : (on.noReport ?? evidence)} ` +
          `${on.results.length - onFailed}/${on.results.length}` +
          `${rerunOff || rerunOn ? ` (rerun ${rerunOff ? "off" : ""}${rerunOn ? "on" : ""})` : ""}  ${file}`,
      );
    }
  } finally {
    report(runs);
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${files.length} files in ${Math.round((Date.now() - started) / 1000)} s`);
  return failures(runs) ? 1 : 0;
}

/** Counts as a failed leg: any failed test, or no report at all. */
function legFailed(run: LegRun): boolean {
  return run.noReport !== undefined || run.results.some((result) => result.status === "failed");
}

/** The skips of a file, from both legs. */
function skips(run: FileRun): Result[] {
  return [...run.off.results, ...run.on.results].filter(
    (result) => result.status !== "passed" && result.status !== "failed",
  );
}

/** Whether any rule failed; prints each failing group. */
function failures(runs: readonly FileRun[]): boolean {
  let failed = false;
  const onOnly = runs.filter((run) => legFailed(run.on) && !legFailed(run.off));
  const both = runs.filter((run) => legFailed(run.on) && legFailed(run.off));
  const noEvidence = runs.filter((run) => run.on.noReport === undefined && run.evidence === "NONE");
  const noReport = runs.filter(
    (run) => run.off.noReport !== undefined || run.on.noReport !== undefined,
  );
  // A native-only case skips on the off leg by design (the switch guard); everything else, and
  // every skip on the on leg, needs a platform guard to be explained.
  const unexplained = runs.filter(
    (run) =>
      !run.platformGuard && skips(run).some((result) => !(run.switchGuard && result.leg === "off")),
  );
  const skipped = runs.filter((run) => skips(run).length > 0);

  console.log("\n=== failures ===");
  const group = (title: string, entries: readonly FileRun[], detail: () => void) => {
    if (!entries.length) return;
    failed = true;
    console.log(`\n${title} (${entries.length})`);
    for (const entry of entries) console.log(`  ${entry.file}`);
    detail();
  };
  group("on leg fails, off passes", onOnly, () => {
    for (const entry of onOnly)
      for (const result of entry.on.results.filter((one) => one.status === "failed"))
        console.log(`    ${result.fullName}\n      ${(result.message ?? "").split("\n")[0]}`);
    for (const entry of onOnly)
      if (entry.on.noReport !== undefined || entry.on.results.length === 0)
        console.log(`    report: ${entry.on.noReport ?? "no tests"}\n${tail(entry.on.output)}`);
  });
  group("both legs fail (pre-existing)", both, () => {
    for (const entry of both)
      for (const result of entry.off.results.filter((one) => one.status === "failed"))
        console.log(`    ${result.fullName}\n      ${(result.message ?? "").split("\n")[0]}`);
  });
  group("on leg without evidence", noEvidence, () => {
    for (const entry of noEvidence) console.log(`    ${entry.file}: ${entry.evidence}`);
  });
  group("no report", noReport, () => {
    for (const entry of noReport) {
      if (entry.off.noReport !== undefined)
        console.log(`    ${entry.file} off: ${entry.off.noReport}\n${tail(entry.off.output)}`);
      if (entry.on.noReport !== undefined)
        console.log(`    ${entry.file} on: ${entry.on.noReport}\n${tail(entry.on.output)}`);
    }
  });
  group("skips with no platform guard", unexplained, () => {
    for (const entry of unexplained)
      for (const result of skips(entry).filter((one) => !(entry.switchGuard && one.leg === "off")))
        console.log(`    ${entry.file} ${result.leg}: ${result.fullName} (${result.status})`);
  });

  console.log(`\n=== skipped tests (${skipped.length} files) ===`);
  for (const entry of skipped) {
    const guard = entry.platformGuard
      ? "platform guard"
      : entry.switchGuard
        ? "switch guard"
        : "NO GUARD";
    console.log(`  ${entry.file} [${guard}]`);
    for (const result of skips(entry))
      console.log(`    ${result.leg}: ${result.fullName} (${result.status})`);
  }
  return failed;
}

function tail(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "    (no output)";
  return trimmed
    .split("\n")
    .slice(-20)
    .map((line) => `      ${line}`)
    .join("\n");
}

/** The per-file table, for the PR. */
function report(runs: readonly FileRun[]): void {
  const count = (run: FileRun, leg: "off" | "on") => {
    const results = leg === "off" ? run.off.results : run.on.results;
    const passed = results.filter((result) => result.status === "passed").length;
    return `${passed}/${results.length}`;
  };
  console.log("\n=== per file ===");
  console.log("off\t on\t evidence\tfile");
  for (const run of runs)
    console.log(
      `${count(run, "off")}\t${count(run, "on")}\t${run.evidence}\t${run.file}` +
        `${run.rerun.off || run.rerun.on ? `\t(rerun ${run.rerun.off ? "off " : ""}${run.rerun.on ? "on" : ""})` : ""}`,
    );
}

process.exitCode = main();
