import { stat } from "node:fs/promises";
import { z } from "zod";
import { CommandId, ThreadId } from "@ace/protocol";
import { ADMISSIONS_THREAD_ID } from "./fixture-admissions.ts";
import {
  abortOwnedFetches,
  fetchTextCapped,
  killOwnedChildren,
  runBounded,
} from "./fixture-send-process.ts";

// Bounded A00.05c driver: existing fixture-send scenario on one explicit
// device, zero-before/exactly-one-after admission. No AVD/data/server/build ops.
// Probes are constrained to [A-Za-z0-9._~-] so the `adb shell` argument vector
// needs no remote-shell quoting: no metacharacter can appear.
const PROBE_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
const FIXTURE_BASE = "http://127.0.0.1:4345";
const METRO_STATUS = "http://127.0.0.1:8083/status";
const TEST_COMPONENT = "dev.ace.android.test/dev.ace.android.benchmark.SpikeInstrumentation";
const OVERALL_MAX_MS = 180_000;
const NEGATIVE_OK_MARKER = "NEGATIVE_CONTROL_OK";

type Args = {
  serial: string;
  appApk: string;
  testApk: string;
  probe: string;
  negativeProbe: string | undefined;
  overallMs: number;
};

class PrereqError extends Error {}
class VerifyError extends Error {}

const AdmissionsBody = z.object({ commandIds: z.array(CommandId) });

function usage(): string {
  return [
    "usage: node scripts/fixture-send.ts --serial S --app-apk A --test-apk T --probe P",
    "  [--negative-probe N] [--overall-timeout-ms 180000]",
    "P/N match [A-Za-z0-9._~-]{1,200}, e.g. --probe fs-1761600000-a1b2c3.",
    "0 pass; 1 verification failure; 2 usage/prerequisite failure.",
  ].join("\n");
}

function checkProbe(label: string, raw: string): string {
  if (!PROBE_PATTERN.test(raw)) throw new Error(`${label} must match [A-Za-z0-9._~-]{1,200}`);
  return raw;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? undefined : v;
  };
  const known = new Set([
    "--serial",
    "--app-apk",
    "--test-apk",
    "--probe",
    "--negative-probe",
    "--overall-timeout-ms",
  ]);
  for (const t of argv.slice(2)) {
    if (t.startsWith("--") && !known.has(t)) throw new Error(`unknown flag ${t}`);
  }
  const serial = get("--serial") ?? "";
  const appApk = get("--app-apk") ?? "";
  const testApk = get("--test-apk") ?? "";
  if (serial === "" || appApk === "" || testApk === "") throw new Error("missing required flag");
  const probe = checkProbe("probe", get("--probe") ?? "");
  const negRaw = get("--negative-probe");
  const negativeProbe = negRaw === undefined ? undefined : checkProbe("negative-probe", negRaw);
  if (negativeProbe !== undefined && negativeProbe === probe) {
    throw new Error("negative-probe must differ from probe");
  }
  const overallMs = Number(get("--overall-timeout-ms") ?? String(OVERALL_MAX_MS));
  if (!Number.isInteger(overallMs) || overallMs <= 0 || overallMs > OVERALL_MAX_MS) {
    throw new Error("overall-timeout-ms must be 1..180000");
  }
  ThreadId.parse(ADMISSIONS_THREAD_ID);
  return { serial, appApk, testApk, probe, negativeProbe, overallMs };
}

function parseAdmissions(text: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error("admissions is not JSON");
  }
  return AdmissionsBody.parse(body).commandIds;
}

function parseInstrument(stdout: string): { code: string | undefined; m: Map<string, string> } {
  const m = new Map<string, string>();
  const resultPrefix = "INSTRUMENTATION_RESULT:";
  const codePrefix = "INSTRUMENTATION_CODE:";
  let code: string | undefined;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t.startsWith(resultPrefix)) {
      const rest = t.slice(resultPrefix.length).trim();
      const eq = rest.indexOf("=");
      if (eq > 0) m.set(rest.slice(0, eq).trim(), rest.slice(eq + 1).trim());
    } else if (t.startsWith(codePrefix)) {
      code = t.slice(codePrefix.length).trim();
    }
  }
  return { code, m };
}

function admissionsUrl(p: string): string {
  const tid = encodeURIComponent(ADMISSIONS_THREAD_ID);
  return `${FIXTURE_BASE}/admissions?threadId=${tid}&probe=${encodeURIComponent(p)}`;
}

/**
 * Exact `adb reverse --list` parse: `<transport> <remote> <local>` per line.
 * Transport is a bus tag (`usb`, `host`, …), never the selected serial; the
 * `-s <serial>` flag already scopes output to our device, so only the exact
 * remote/local pair is matched. A remote bound elsewhere is a conflict.
 */
function findReverse(stdout: string, spec: string): "absent" | "equal" | "conflict" {
  let state: "absent" | "equal" | "conflict" = "absent";
  for (const line of stdout.split("\n")) {
    const fields = line
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0);
    if (fields.length < 3) continue;
    if (fields[1] !== spec) continue;
    if (fields[2] === spec) {
      if (state === "absent") state = "equal";
    } else {
      state = "conflict";
    }
  }
  return state;
}

async function requireDevice(serial: string, budgetMs: number): Promise<void> {
  const listed = await runBounded("adb", ["devices", "-l"], Math.min(10_000, budgetMs));
  if (listed.exitCode !== 0) throw new PrereqError(`adb devices failed: ${listed.stderr.trim()}`);
  let state = "";
  let seen = false;
  for (const line of listed.stdout.split("\n").slice(1)) {
    const parts = line
      .trim()
      .split(/\s+/)
      .filter((x) => x.length > 0);
    if (parts.length < 2) continue;
    if ((parts[0] ?? "") === serial) {
      seen = true;
      state = parts[1] ?? "";
    }
  }
  if (!seen) throw new PrereqError(`unknown device ${serial}; refusing`);
  if (state !== "device") throw new PrereqError(`device ${serial} is ${state}; refusing`);
}

async function reverseList(serial: string, budgetMs: number): Promise<string> {
  const listed = await runBounded(
    "adb",
    ["-s", serial, "reverse", "--list"],
    Math.min(10_000, budgetMs),
  );
  if (listed.exitCode !== 0)
    throw new PrereqError(`reverse --list failed: ${listed.stderr.trim().slice(0, 500)}`);
  return listed.stdout;
}

async function ensureReverse(serial: string, spec: string, budgetMs: number): Promise<boolean> {
  const first = findReverse(await reverseList(serial, budgetMs), spec);
  if (first === "equal") return false;
  if (first === "conflict")
    throw new PrereqError(`reverse conflict: ${spec} bound elsewhere; refusing`);
  const added = await runBounded(
    "adb",
    ["-s", serial, "reverse", "--no-rebind", spec, spec],
    Math.min(10_000, budgetMs),
  );
  if (added.exitCode === 0) return true;
  const detail = `${added.stdout}\n${added.stderr}`;
  if (!/exists/i.test(detail))
    throw new PrereqError(`reverse ${spec}: ${added.stderr.trim().slice(0, 500)}`);
  // Lost a create race: re-read and reuse only an exactly equal mapping.
  const again = findReverse(await reverseList(serial, budgetMs), spec);
  if (again === "equal") return false;
  throw new PrereqError(`reverse race conflict on ${spec}; refusing`);
}

async function removeReverse(serial: string, spec: string): Promise<void> {
  try {
    await runBounded("adb", ["-s", serial, "reverse", "--remove", spec], 10_000);
  } catch {
    // Best effort; only mappings this run added are ever removed.
  }
}

async function observe(probeText: string, budgetMs: number): Promise<string[]> {
  return parseAdmissions(
    await fetchTextCapped(admissionsUrl(probeText), Math.min(10_000, budgetMs)),
  );
}

async function pollOne(probeText: string, budgetMs: number): Promise<number> {
  const pollEnd = Date.now() + Math.min(30_000, budgetMs);
  let count = 0;
  while (Date.now() < pollEnd) {
    const ids = await observe(probeText, Math.max(1, pollEnd - Date.now()));
    count = ids.length > 2 ? 2 : ids.length;
    if (count === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return count;
}

async function flow(args: Args, left: () => number): Promise<number> {
  let phase: "prereq" | "verify" = "prereq";
  const owned: string[] = [];
  const cleanupOwned = async (): Promise<void> => {
    for (const spec of owned.splice(0)) await removeReverse(args.serial, spec);
  };
  try {
    for (const f of [args.appApk, args.testApk]) {
      const info = await stat(f).catch(() => undefined);
      if (info === undefined || !info.isFile()) throw new PrereqError(`apk not found: ${f}`);
    }
    await requireDevice(args.serial, left());
    // Already-running services only; never launched here.
    const metro = await fetchTextCapped(METRO_STATUS, Math.min(10_000, left())).catch(
      () => undefined,
    );
    if (metro === undefined || !metro.includes("packager-status:running")) {
      throw new PrereqError("Metro 8083 not running; refusing to start it");
    }
    for (const spec of ["tcp:4345", "tcp:8083"]) {
      if (await ensureReverse(args.serial, spec, left())) owned.push(spec);
    }
    for (const a of [
      ["-s", args.serial, "install", "-r", args.appApk],
      ["-s", args.serial, "install", "-t", "-r", args.testApk],
    ]) {
      const r = await runBounded("adb", a, Math.min(90_000, left()));
      if (r.exitCode !== 0) throw new PrereqError(`install failed: ${r.stderr.trim()}`);
    }
    // Network failure (host unreachable) stays a prerequisite; a reachable
    // host answering malformed JSON is a verification-side schema rejection.
    const fixtureDown = async (p: string): Promise<string[]> => {
      let text: string;
      try {
        text = await fetchTextCapped(admissionsUrl(p), Math.min(10_000, left()));
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new PrereqError("fixture 4345 unreachable; refusing to start it");
      }
      try {
        return parseAdmissions(text);
      } catch (error: unknown) {
        throw new VerifyError(
          `admissions schema rejected: ${error instanceof Error ? error.message : "invalid"}`,
        );
      }
    };
    if ((await fixtureDown(args.probe)).length !== 0) {
      throw new VerifyError("probe P nonzero before send");
    }
    if (args.negativeProbe !== undefined && (await fixtureDown(args.negativeProbe)).length !== 0) {
      throw new VerifyError("probe N nonzero before send");
    }
    phase = "verify";
    // Constrained charset: no remote-shell quoting needed for probeText.
    const inst = await runBounded(
      "adb",
      [
        "-s",
        args.serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-e",
        "scenario",
        "fixture-send",
        "-e",
        "probeText",
        args.probe,
        TEST_COMPONENT,
      ],
      Math.min(120_000, left()),
    );
    const parsed = parseInstrument(inst.stdout);
    const ok =
      inst.exitCode === 0 &&
      parsed.code === "-1" &&
      parsed.m.get("scenario") === "fixture-send" &&
      parsed.m.get("fixtureSend") === "passed" &&
      parsed.m.get("sendClicks") === "1" &&
      parsed.m.get("probeLength") === String(args.probe.length);
    if (!ok) {
      console.error(
        `fixture-send: instrument rejected (adb=${inst.exitCode} code=${parsed.code ?? "?"})`,
      );
      console.error(inst.stdout.slice(-4096));
      throw new VerifyError("instrument bundle mismatch");
    }
    if ((await pollOne(args.probe, left())) !== 1) {
      throw new VerifyError("probe P was not admitted exactly once");
    }
    if (args.negativeProbe === undefined) {
      console.log(`fixture-send: PASS probeLength=${args.probe.length} sendClicks=1 admissions=1`);
      return 0;
    }
    // Negative control: the SAME exactly-one assertion now runs against N.
    const n = await pollOne(args.negativeProbe, left());
    if (n === 0) {
      console.error(`fixture-send: ${NEGATIVE_OK_MARKER} p_admitted_once=1 n_admissions=0`);
      throw new VerifyError("negative control behaved as required");
    }
    if (n === 1) {
      console.log("fixture-send: unexpected negative green (N admitted); lane must fail");
      return 0;
    }
    throw new VerifyError("probe N admitted more than once");
  } catch (error: unknown) {
    if (error instanceof PrereqError) {
      console.error(`fixture-send: prereq: ${error.message}`);
      return 2;
    }
    console.error(`fixture-send: ${error instanceof Error ? error.message : "failed"}`);
    return phase === "verify" ? 1 : 2;
  } finally {
    await cleanupOwned();
  }
}

function onSignal(): void {
  abortOwnedFetches();
  void killOwnedChildren("signal");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (error: unknown) {
    console.error(
      `fixture-send: ${error instanceof Error ? error.message : "bad args"}\n${usage()}`,
    );
    process.exitCode = 2;
    return;
  }
  const overallMs = args.overallMs;
  const start = Date.now();
  const left = (): number => Math.max(1, start + overallMs - Date.now());
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const watchdog = setTimeout(() => {
    abortOwnedFetches();
    void killOwnedChildren("deadline");
  }, overallMs);
  watchdog.unref();
  let code = 2;
  try {
    code = await flow(args, left);
  } finally {
    clearTimeout(watchdog);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await killOwnedChildren("cleanup");
    process.exitCode = code;
  }
}

void main();
