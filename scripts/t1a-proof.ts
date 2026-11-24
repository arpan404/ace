// SPDX-License-Identifier: Apache-2.0
/**
 * The transport's proof run (ADR 0226, T1a.8): every test file that starts a server, run twice,
 * once with the Rust loopback listener on and once with `ACE_TRANSPORT` off, one file at a time.
 *
 * The list comes from `list-server-tests.ts`. Each leg writes a Vitest JSON report and the on leg
 * a fresh `ACE_TRANSPORT_EVIDENCE` file; a report is read with `JSON.parse(readFileSync(...))`,
 * never `require`. Every test of both legs is recorded per test. The on leg is `native` only when
 * it executed a test and the evidence file is non-empty. A skipped test in a file with no
 * identified platform guard is a failure, so one guard can't hide an unrelated skip.
 *
 * The on leg runs first. When it passes with no evidence, the switch never took effect and the
 * off leg would be identical, so the off leg is skipped and recorded as such; a failing on leg or
 * one with native evidence still runs the off leg.
 *
 * Runs with `node scripts/t1a-proof.ts`. It exits non-zero on any failed leg, a report missing,
 * unparsable or empty, or a skip without a platform guard. An on leg with no evidence is a note,
 * not a failure: the closure deliberately lists the files that import a server-starting helper,
 * and some of them never start a server, so their on leg has no listener to prove. Before
 * each file it waits up to two minutes for the shared machine's 1-minute load average to fall
 * under 60, then runs anyway: this run proves pass/fail and evidence, not timing. A leg that
 * failed only by timing out is rerun once, alone, and the table says so.
 *
 * For a long list: `--from N` starts at the Nth file (1-based), `--shard i/n` keeps the files
 * whose sorted index is `i` mod `n`, and `--results <path>` writes this run's results as JSON.
 * `--merge <path...>` reads any mix of those JSON files and proof-run logs, prints the same final
 * report, and exits by the same rules; a JSON result wins over a log's line for the same file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** The leg was not run: the on leg passed with no native evidence, so it would be identical. */
  skipped?: boolean;
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

/** One file of the sorted list, with the index a shard and the progress line use. */
interface Entry {
  index: number;
  file: string;
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

/** Whether a leg executed at least one test, as opposed to skipping all of them. */
function executed(run: LegRun): boolean {
  return run.results.some((result) => result.status === "passed" || result.status === "failed");
}

/** How the on leg proved itself. */
function evidenceOfRun(run: LegRun, ran: boolean, witness: string, platformGuard: boolean) {
  if (run.noReport !== undefined) return "no-report" as const;
  if (!ran) return platformGuard ? ("platform-skipped" as const) : ("no-report" as const);
  return evidenceOf(witness) ? ("native" as const) : ("NONE" as const);
}

/** One file's two legs, from this process. */
function runFile(entry: Entry, name: string, work: string): FileRun {
  const { file } = entry;
  waitForLoad();
  const evidencePath = join(work, `${name}-evidence.jsonl`);
  let on = runLeg(file, "on", join(work, `${name}-on.json`), evidencePath);
  // A leg that failed only by timing out gets one more run, alone, on a fresh report.
  let rerunOn = false;
  if (timedOutOnly(on)) {
    rerunOn = true;
    on = runLeg(file, "on", join(work, `${name}-on-retry.json`), `${evidencePath}.retry`);
  }
  const witness = rerunOn ? `${evidencePath}.retry` : evidencePath;
  const text = readFileSync(join(root, file), "utf8");
  const platformGuard = hasPlatformGuard(text);
  const evidence = evidenceOfRun(on, executed(on), witness, platformGuard);
  let off: LegRun;
  let rerunOff = false;
  // The on leg passed with no evidence: ACE_TRANSPORT never took effect, so the off leg (which
  // runs without it) would be the same tests with the same result. Record the skip, run nothing.
  // A failing on leg still gets its off leg, so a pre-existing failure is not mistaken for one.
  if (evidence === "NONE" && !legFailed(on)) {
    off = { noReport: undefined, results: [], status: null, output: "", skipped: true };
  } else {
    off = runLeg(file, "off", join(work, `${name}-off.json`), "");
    if (timedOutOnly(off)) {
      rerunOff = true;
      off = runLeg(file, "off", join(work, `${name}-off-retry.json`), "");
    }
  }
  return {
    file,
    off,
    on,
    evidence,
    rerun: { off: rerunOff, on: rerunOn },
    platformGuard,
    switchGuard: hasSwitchGuard(text),
  };
}

/** The progress line, and the form `--merge` reads back from a log. */
function progressLine(entry: Entry, total: number, run: FileRun): string {
  const offFailed = run.off.results.filter((result) => result.status === "failed").length;
  const onFailed = run.on.results.filter((result) => result.status === "failed").length;
  const offState = run.off.skipped
    ? "skipped (on had no native evidence)"
    : (run.off.noReport ?? "PASS");
  const onState = run.evidence === "native" ? "native" : (run.on.noReport ?? run.evidence);
  const rerun =
    run.rerun.off || run.rerun.on
      ? ` (rerun ${[run.rerun.off ? "off" : "", run.rerun.on ? "on" : ""].filter(Boolean).join(" ")})`
      : "";
  return (
    `[${String(entry.index + 1).padStart(3)}/${total}] ` +
    `off ${offState} ${run.off.results.length - offFailed}/${run.off.results.length}  ` +
    `on ${onState} ${run.on.results.length - onFailed}/${run.on.results.length}` +
    `${rerun}  ${run.file}`
  );
}

function main(): number {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };
  const merge = (() => {
    const at = args.indexOf("--merge");
    if (at < 0) return undefined;
    return args.slice(at + 1).filter((value) => !value.startsWith("--"));
  })();
  if (merge !== undefined) {
    const runs = mergeRuns(merge);
    report(runs);
    return failures(runs) ? 1 : 0;
  }
  const files = listServerTests();
  const from = Math.max(1, Number(flag("--from") ?? "1"));
  const shard = flag("--shard");
  const [shardIndex, shardCount] =
    shard === undefined ? [0, 1] : shard.split("/").map((value) => Number(value));
  if (
    shardCount === undefined ||
    shardIndex === undefined ||
    !(shardCount > 0) ||
    shardIndex < 0 ||
    shardIndex >= shardCount
  )
    throw new Error("--shard takes i/n with 0 <= i < n");
  const entries: Entry[] = [];
  for (const [index, file] of files.entries())
    if (index + 1 >= from && index % shardCount === shardIndex) entries.push({ index, file });
  const work = mkdtempSync(join(tmpdir(), "t1a-proof-"));
  const runs: FileRun[] = [];
  const started = Date.now();
  try {
    for (const entry of entries) {
      const run = runFile(entry, `${entry.index}`, work);
      runs.push(run);
      console.log(progressLine(entry, files.length, run));
    }
  } finally {
    report(runs);
    rmSync(work, { recursive: true, force: true });
  }
  const results = flag("--results");
  if (results !== undefined) writeFileSync(results, `${JSON.stringify({ files: runs })}\n`);
  console.log(`\n${entries.length} files in ${Math.round((Date.now() - started) / 1000)} s`);
  return failures(runs) ? 1 : 0;
}

/** The progress line's fields: the state words, the counts, the rerun marker and the file. */
const LINE =
  /^\[\s*\d+\/\d+\]\s+off\s+(PASS|skipped|missing|unparsable|empty)(?:\s+\(([^)]*)\))?\s+(\d+)\/(\d+)\s+on\s+(\S+)\s+(\d+)\/(\d+)(?:\s+\(rerun\s+([^)]*)\))?\s{2,}(.+)$/;

/** A leg from a log line: counts become pass/fail placeholders, no test names to recover. */
function legFromLog(state: string, passed: number, total: number, leg: Leg): LegRun {
  if (state === "skipped")
    return { noReport: undefined, results: [], status: null, output: "", skipped: true };
  if (state === "missing" || state === "unparsable" || state === "empty")
    return { noReport: state, results: [], status: null, output: "" };
  const results: Result[] = [];
  for (let index = 0; index < total; index++)
    results.push({
      file: "",
      fullName: "(log only)",
      leg,
      status: index < passed ? "passed" : "failed",
    });
  return { noReport: undefined, results, status: null, output: "" };
}

/** Results from one proof-run log, which records states and counts but no test names. */
function runsFromLog(path: string): FileRun[] {
  const runs: FileRun[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = LINE.exec(line);
    if (match === null) continue;
    const [, state, , passedOff, totalOff, stateOn, passedOn, totalOn, rerun, file] = match;
    const off = legFromLog(state ?? "", Number(passedOff), Number(totalOff), "off");
    const onLeg =
      stateOn === "native" || stateOn === "NONE" || stateOn === "platform-skipped"
        ? legFromLog("PASS", Number(passedOn), Number(totalOn), "on")
        : legFromLog(stateOn ?? "", Number(passedOn), Number(totalOn), "on");
    const evidence: FileRun["evidence"] =
      stateOn === "native" || stateOn === "NONE" || stateOn === "platform-skipped"
        ? stateOn
        : "no-report";
    const rerunFlags = rerun ?? "";
    runs.push({
      file: file ?? "",
      off,
      on: onLeg,
      evidence,
      rerun: { off: rerunFlags.includes("off"), on: rerunFlags.includes("on") },
      platformGuard: false,
      switchGuard: false,
    });
  }
  return runs;
}

/** JSON results and logs, deduped by file: a JSON result wins over a log line. */
function mergeRuns(paths: readonly string[]): FileRun[] {
  const merged = new Map<string, FileRun>();
  const json = paths.filter((path) => path.endsWith(".json"));
  for (const path of paths) {
    if (path.endsWith(".json")) continue;
    for (const run of runsFromLog(path)) if (!merged.has(run.file)) merged.set(run.file, run);
  }
  for (const path of json) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { files?: FileRun[] };
    for (const run of parsed.files ?? []) {
      // A report written by an older runner may spell "no failure" as null.
      for (const leg of [run.off, run.on])
        if ((leg.noReport as unknown) === null) leg.noReport = undefined;
      merged.set(run.file, run);
    }
  }
  return [...merged.values()].toSorted((left, right) => left.file.localeCompare(right.file));
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
  const onOnly = runs.filter((run) => legFailed(run.on) && !legFailed(run.off) && !run.off.skipped);
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
  const note = (title: string, entries: readonly FileRun[], detail: () => void) => {
    if (!entries.length) return;
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
  // Not a failure: the file is in the list because it imports a server-starting helper, but the
  // on leg never reached a listener, so there is no native evidence to prove and nothing to fix.
  note("on leg without evidence (NONE): reported, not a failure", noEvidence, () => {
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
    if (leg === "off" && run.off.skipped) return "skipped";
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
