import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  gateMarkdown,
  gateProfiles,
  gateRow,
  linkResult,
  type GateProfile,
  type GateReport,
  type GateRow,
  type LinkResult,
} from "./3g-gate-report.ts";

/*
 * The M2b bench gate, unattended: runs `video-link.ts` on the default 25 Mbit/s profile and on
 * `3g-1600` and `3g-400`, each only while the Mac is quiet. Before each run it waits for the
 * 1-minute load average to fall below `--max-load` (24 by default, for 16 cores); during the run
 * it samples the load every 3 s, and a run whose load goes over is thrown away and retried.
 * It gives up at `--deadline` and writes what it has, after every run, to `<out>.json` and
 * `<out>.md`: the clean-run table with each profile's merge bar (`3g-gate-report.ts`).
 *
 *   node packages/browser/bench/3g-gate.ts --deadline 2026-11-15T07:00 --out /tmp/3g-gate
 *
 * Exits 0 when every profile has a clean run that meets its bar, 1 otherwise.
 */

const { values } = parseArgs({
  options: {
    deadline: { type: "string" },
    out: { type: "string" },
    "max-load": { type: "string", default: "24" },
  },
});
if (!values.deadline || !values.out) {
  console.error(
    "usage: node packages/browser/bench/3g-gate.ts --deadline <ISO time> --out <path without extension> [--max-load 24]",
  );
  process.exit(2);
}
const deadline = new Date(values.deadline);
if (Number.isNaN(deadline.getTime())) {
  console.error(`--deadline ${values.deadline} is not a time`);
  process.exit(2);
}
const maxLoad = Number(values["max-load"]);
const out = values.out;
const bench = fileURLToPath(new URL("./video-link.ts", import.meta.url));
const pollMs = 30_000;
const sampleMs = 3_000;
/** A run takes about 30 s with Chrome's start; don't start one that can't finish in time. */
const runMs = 60_000;

const load = () => loadavg()[0] ?? Infinity;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();
const log = (line: string) => console.log(`${stamp()} ${line}`);

/** Waits for the load to fall below `maxLoad`; false once the deadline leaves no time to run. */
async function quiet(): Promise<boolean> {
  for (;;) {
    if (Date.now() + runMs > deadline.getTime()) return false;
    const now = load();
    if (now < maxLoad) return true;
    log(`load ${now.toFixed(1)}, waiting`);
    await sleep(pollMs);
  }
}

/** One run of the bench; its result and the highest load sampled while it ran. */
function runOnce(profile: GateProfile): Promise<{ result?: LinkResult; maxLoad: number }> {
  return new Promise((resolve) => {
    let peak = load();
    const sampler = setInterval(() => {
      peak = Math.max(peak, load());
    }, sampleMs);
    // Report-only: the gate judges the bar itself, so an unmet target never stops the night.
    const env: NodeJS.ProcessEnv = { ...process.env, ACE_VIDEO_LINK_REPORT_ONLY: "1" };
    if (profile === "phone") delete env.ACE_VIDEO_LINK_PROFILE;
    else env.ACE_VIDEO_LINK_PROFILE = profile;
    const child = spawn(process.execPath, [bench], { env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", () => {
      clearInterval(sampler);
      peak = Math.max(peak, load());
      const line = stdout.split("\n").findLast((text) => text.startsWith("{"));
      let result: LinkResult | undefined;
      try {
        result = line ? linkResult(JSON.parse(line)) : undefined;
      } catch {
        result = undefined;
      }
      resolve({ ...(result ? { result } : {}), maxLoad: peak });
    });
  });
}

const rows = new Map<GateProfile, GateRow>();
const discarded: GateReport["discarded"] = [];

function write(): GateReport {
  const report: GateReport = {
    maxLoad,
    deadline: deadline.toISOString(),
    finishedAt: stamp(),
    rows: gateProfiles.flatMap((profile) => {
      const row = rows.get(profile);
      return row ? [row] : [];
    }),
    discarded,
    missing: gateProfiles.filter((profile) => !rows.has(profile)),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${out}.md`, gateMarkdown(report));
  return report;
}

write();
for (const profile of gateProfiles) {
  while (!rows.has(profile)) {
    if (!(await quiet())) break;
    const startedAt = stamp();
    log(`${profile}: running at load ${load().toFixed(1)}`);
    const { result, maxLoad: peak } = await runOnce(profile);
    if (!result) {
      log(`${profile}: the bench printed no result; retrying`);
      continue;
    }
    if (peak >= maxLoad) {
      log(`${profile}: load reached ${peak.toFixed(1)}, discarded`);
      discarded.push({ profile, startedAt, maxLoad: peak });
      write();
      continue;
    }
    const row = gateRow({ profile, startedAt, maxLoad: peak, result });
    rows.set(profile, row);
    log(`${profile}: clean (max load ${peak.toFixed(1)}), bar ${row.met ? "met" : "not met"}`);
    write();
  }
}
const report = write();
log(`wrote ${out}.json and ${out}.md`);
process.exitCode = report.missing.length === 0 && report.rows.every((row) => row.met) ? 0 : 1;
