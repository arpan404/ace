/**
 * E3.0d: the session bench. It drives one provider's adapter against that provider's synthetic
 * peer (`session-stream/<provider>.ts`, also the fake) and reports the CPU cost of the frame
 * path:
 *
 *   cpuMsPer1000Frames = (user + system microseconds over the ten turns) / 1000
 *                        / (frames delivered / 1000)
 *
 * `process.cpuUsage()` covers every thread of the process, so a native addon's tokio threads
 * count too. Modes:
 *
 *   A  off
 *   B  ACE_TRANSLATORS=<provider>
 *   C  B + ACE_STORE=native ACE_SUPERVISOR=native
 *   D  C + ACE_SESSIONS=<provider> (needs that provider's native session and its evidence
 *      line; refused without them, so the TypeScript session is never mistaken for it)
 *
 * Every mode runs in its own process. A full run measures three rounds of A B C D, discards a
 * round whose one-minute load average differs by more than 2x between its A and D runs, and
 * reports the median D/A ratio. A provider may be default-on only when that median is <= 1.00
 * and D's median frames per second is at least A's (the owner's rule, E3.0d step 6).
 *
 *   bun apps/daemon/bench/session-stream.ts [--provider pi|acp] [--rounds 3] [--output file]
 *   bun --expose-gc apps/daemon/bench/session-stream.ts --mode A [--output file]
 *
 * It never starts a real CLI and spends no quota. It is not a test and runs in no test tier.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Frame, SessionContext } from "@ace/engine-api";
import { acp } from "./session-stream/acp.ts";
import { pi } from "./session-stream/pi.ts";
import type { BenchMode, BenchProvider } from "./session-stream/provider.ts";

type Mode = BenchMode;
const MODES: readonly Mode[] = ["A", "B", "C", "D"];
const TURNS = 10;
/** The owner's rule: a switch defaults on only when this bench shows it no slower than off. */
const DEFAULT_ON_MAX_RATIO = 1.0;
/** A round whose A and D one-minute load averages differ by more than this is rerun. */
const MAX_LOAD_SPREAD = 2;
/** Never start a measurement while the machine is busy (the brief's one-bench-at-a-time gate). */
const LOAD_LIMIT = 60;

const script = fileURLToPath(import.meta.url);

/** Every provider the bench can drive; a `codex.ts` joins this map with E3-codex.5. */
const PROVIDERS: Readonly<Record<string, BenchProvider>> = { pi, acp };
const SWITCH_KEYS = [
  "ACE_TRANSLATORS",
  "ACE_STORE",
  "ACE_SUPERVISOR",
  "ACE_SESSIONS",
  "ACE_NATIVE_CROSS",
  "ACE_ENGINE",
] as const;

const ModeResultSchema = z.object({
  mode: z.enum(["A", "B", "C", "D"]),
  switches: z.record(z.string(), z.string()),
  pid: z.number().int(),
  load1: z.number(),
  turns: z.number().int(),
  frames: z.number().int(),
  cpuMs: z.number(),
  cpuMsPer1000Frames: z.number(),
  framesPerSecond: z.number(),
  elapsedMs: z.number(),
  heapUsed: z.number(),
  evidence: z.object({ lines: z.number().int(), ok: z.boolean() }),
});
type ModeResult = z.infer<typeof ModeResultSchema>;

const EvidenceLine = z.object({
  provider: z.enum(["pi", "acp"]),
  backend: z.literal("native"),
  pid: z.number().int(),
});

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("median of no values");
  return middle;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const equality = process.argv.find((value) => value.startsWith(prefix));
  return equality?.slice(prefix.length);
}

function parseMode(value: string | undefined): Mode | undefined {
  return value === "A" || value === "B" || value === "C" || value === "D" ? value : undefined;
}

/** The provider this run drives; Pi unless `--provider` names another. */
function chosenProvider(): BenchProvider {
  const name = option("provider") ?? "pi";
  const provider = PROVIDERS[name];
  if (provider === undefined)
    throw new Error(`--provider takes ${Object.keys(PROVIDERS).join(" or ")}, not ${name}`);
  return provider;
}

function outputPath(): string {
  return option("output") ?? join(tmpdir(), "ace-session-stream-bench.json");
}

/** Each mode is a fresh process, so the switches are fixed before any module reads them. */
function applyMode(mode: Mode, evidence: string, provider: BenchProvider): void {
  for (const key of SWITCH_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(provider.switches(mode))) process.env[key] = value;
  process.env.ACE_SESSIONS_EVIDENCE = evidence;
}

function appliedSwitches(): Record<string, string> {
  const switches: Record<string, string> = {};
  for (const key of SWITCH_KEYS) {
    const value = process.env[key];
    if (value !== undefined) switches[key] = value;
  }
  return switches;
}

async function waitForLoad(limit = LOAD_LIMIT): Promise<void> {
  for (;;) {
    const load = loadavg()[0] ?? 0;
    if (load < limit) return;
    process.stderr.write(
      `waiting: one-minute load average ${load.toFixed(1)} is not under ${limit}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

/**
 * The provider's native facade may be absent. Its binding exports `nativeExport`; checking that
 * in a dedicated process keeps the addon out of any process that later opens a session. Without
 * it, mode D would silently measure the TypeScript session, so it refuses instead.
 */
async function checkNativeSession(provider: BenchProvider): Promise<void> {
  applyMode("D", join(tmpdir(), "ace-session-bench-evidence-check.jsonl"), provider);
  if (process.env.ACE_SESSIONS !== provider.id)
    throw new Error(`the native ${provider.id} session check needs ACE_SESSIONS=${provider.id}`);
  const { sessionsAddonPath } = await import("@ace/provider-kit/native-switches");
  const addon = sessionsAddonPath();
  if (!existsSync(addon)) {
    process.stderr.write(
      `mode D is refused: ACE_SESSIONS=${provider.id} needs the sessions addon at ${addon} ` +
        `exporting ${provider.nativeExport}, and no such file exists; build native/daemon with ` +
        "cargo build --release. Nothing is measured, so the TypeScript session is never " +
        "mistaken for the native path.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const module = { exports: {} as Record<string, unknown> };
    process.dlopen(module, addon);
    if (typeof module.exports[provider.nativeExport] !== "function") {
      process.stderr.write(
        `mode D is refused: ACE_SESSIONS=${provider.id} needs ${provider.nativeExport} in the ` +
          `sessions addon at ${addon}, and this build does not export it. Nothing is measured, ` +
          "so the TypeScript session is never mistaken for the native path.\n",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `mode D is refused: the sessions addon at ${addon} could not be loaded ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        `ACE_SESSIONS=${provider.id} needs a working native ${provider.id} session.\n`,
    );
    process.exitCode = 2;
  }
}

/** Why mode D is unavailable, or undefined when the native session is present. */
async function nativeSessionRefusal(provider: BenchProvider): Promise<string | undefined> {
  const child = spawn(
    process.execPath,
    [script, "--provider", provider.id, "--mode", "D", "--check"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let message = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    message += chunk.toString();
  });
  const code = await exitCode(child);
  if (code === 0) return undefined;
  return message.trim() || `the native ${provider.id} session check failed (exit ${code})`;
}

async function runMode(mode: Mode, output: string, provider: BenchProvider): Promise<void> {
  await waitForLoad();
  const home = await mkdtemp(join(tmpdir(), `ace-session-bench-${provider.id}-${mode}-`));
  const evidencePath = join(home, "evidence.jsonl");
  try {
    await writeFile(evidencePath, "");
    applyMode(mode, evidencePath, provider);
    await provider.prepare(home);
    if (typeof globalThis.gc !== "function")
      throw new Error("the heap record needs two forced GCs; run with --expose-gc");

    const { ThreadId } = await import("@ace/protocol");
    const threadId = ThreadId.parse(`${provider.id}-bench`);
    const translator = await provider.translator(threadId);
    let frames = 0;
    const onFrame = (frame: Frame) => {
      frames += 1;
      translator.translate(frame, frame.t);
      translator.takeDiagnostics?.();
      return Promise.resolve();
    };
    const controller = new AbortController();
    const ctx: SessionContext = {
      threadId,
      cwd: home,
      env: provider.env(home),
      signal: controller.signal,
      onFrame,
      onExit: () => {},
    };
    const session = await provider.session(home)(ctx);
    try {
      // One unmeasured turn: the translator's first-frame paths and the child's first writes
      // warm up here, not in the window. Both legs run it, so the comparison stays even.
      await session.send(provider.prompt(0), "queue");
      // The window is the ten turns: neither the open handshake nor the warm-up is counted.
      frames = 0;
      const load1 = loadavg()[0] ?? 0;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      for (let turn = 1; turn <= TURNS; turn++) await session.send(provider.prompt(turn), "queue");
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      globalThis.gc();
      globalThis.gc();
      const heapUsed = process.memoryUsage().heapUsed;

      const expected = TURNS * provider.framesPerTurn;
      if (frames !== expected)
        throw new Error(
          `mode ${mode} delivered ${frames} frames; the ${provider.id} fake prints ${expected}`,
        );
      const cpuMs = (cpu.user + cpu.system) / 1_000;
      const result: ModeResult = {
        mode,
        switches: appliedSwitches(),
        pid: process.pid,
        load1,
        turns: TURNS,
        frames,
        cpuMs: round(cpuMs, 3),
        cpuMsPer1000Frames: round(cpuMs / (frames / 1_000), 4),
        framesPerSecond: round(frames / (elapsedMs / 1_000), 2),
        elapsedMs: round(elapsedMs, 1),
        heapUsed,
        evidence: { lines: 0, ok: false },
      };

      // The native facade appends one line per open; without it mode D's numbers are void.
      const evidence = (await readFile(evidencePath, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0);
      const wanted = mode === "D" ? 1 : 0;
      if (evidence.length !== wanted)
        throw new Error(
          mode === "D"
            ? `mode D is void: ACE_SESSIONS_EVIDENCE holds ${evidence.length} lines, not one per open`
            : `mode ${mode} is void: ACE_SESSIONS_EVIDENCE is not empty`,
        );
      if (mode === "D") {
        const line = EvidenceLine.parse(JSON.parse(evidence[0] ?? ""));
        if (line.pid !== process.pid)
          throw new Error(`mode D is void: the evidence names pid ${line.pid}, not ${process.pid}`);
        if (line.provider !== provider.id)
          throw new Error(
            `mode D is void: the evidence names ${line.provider}, not ${provider.id}`,
          );
      }
      result.evidence = { lines: evidence.length, ok: true };

      await writeFile(output, JSON.stringify(result, null, 2) + "\n");
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally {
      await session.close("shutdown");
      controller.abort();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function runChild(mode: Mode, provider: BenchProvider): Promise<ModeResult> {
  const output = join(tmpdir(), `ace-session-bench-${mode}-${process.pid}-${Date.now()}.json`);
  try {
    const child = spawn(
      process.execPath,
      ["--expose-gc", script, "--provider", provider.id, "--mode", mode, "--output", output],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const code = await exitCode(child);
    if (code !== 0) throw new Error(`mode ${mode} failed (exit ${code})`);
    return ModeResultSchema.parse(JSON.parse(await readFile(output, "utf8")));
  } finally {
    await rm(output, { force: true });
  }
}

type Round = { a: ModeResult; b: ModeResult; c: ModeResult; d: ModeResult };

function loadSpread(left: number, right: number): number {
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  if (low === 0) return high === 0 ? 1 : Number.POSITIVE_INFINITY;
  return high / low;
}

function fpsMedian(rounds: readonly Round[], mode: keyof Round): number {
  return median(rounds.map((value) => value[mode].framesPerSecond));
}

function heapMedian(rounds: readonly Round[], mode: keyof Round): number {
  return median(rounds.map((value) => value[mode].heapUsed));
}

async function runAll(rounds: number, output: string, provider: BenchProvider): Promise<void> {
  const refusal = await nativeSessionRefusal(provider);
  if (refusal !== undefined) {
    process.stderr.write(refusal + "\n");
    process.exitCode = 2;
    return;
  }
  const measured: Round[] = [];
  let attempts = 0;
  while (measured.length < rounds) {
    attempts += 1;
    if (attempts > rounds * 4)
      throw new Error(`the machine stayed too noisy: ${attempts - 1} rounds discarded`);
    await waitForLoad();
    const a = await runChild("A", provider);
    const b = await runChild("B", provider);
    const c = await runChild("C", provider);
    const d = await runChild("D", provider);
    const spread = loadSpread(a.load1, d.load1);
    if (spread > MAX_LOAD_SPREAD) {
      process.stderr.write(
        `round discarded: one-minute load average ${a.load1.toFixed(2)} (A) vs ` +
          `${d.load1.toFixed(2)} (D), ${spread.toFixed(2)}x\n`,
      );
      continue;
    }
    measured.push({ a, b, c, d });
  }

  const ratios = measured.map((value) => value.d.cpuMsPer1000Frames / value.a.cpuMsPer1000Frames);
  const bRatios = measured.map((value) => value.b.cpuMsPer1000Frames / value.a.cpuMsPer1000Frames);
  const cRatios = measured.map((value) => value.c.cpuMsPer1000Frames / value.a.cpuMsPer1000Frames);
  const medianRatio = median(ratios);
  const aFps = fpsMedian(measured, "a");
  const dFps = fpsMedian(measured, "d");
  const defaultOn = medianRatio <= DEFAULT_ON_MAX_RATIO && dFps >= aFps;
  const report = {
    bench: "session-stream",
    provider: provider.id,
    generatedAt: new Date().toISOString(),
    machine: { cpus: cpus().length, load1: loadavg()[0] ?? 0 },
    turns: TURNS,
    framesPerTurn: provider.framesPerTurn,
    rounds: measured,
    aggregation: {
      rule:
        "median(D.cpuMsPer1000Frames / A.cpuMsPer1000Frames) <= 1.00 and " +
        "median(D frames/s) >= median(A frames/s)",
      discardedRounds: attempts - measured.length,
      roundRatios: ratios,
      ratioSpread: { min: Math.min(...ratios), max: Math.max(...ratios) },
      medianRatio,
      bMedianRatio: median(bRatios),
      cMedianRatio: median(cRatios),
      framesPerSecond: {
        a: aFps,
        b: fpsMedian(measured, "b"),
        c: fpsMedian(measured, "c"),
        d: dFps,
      },
      heapUsed: {
        a: heapMedian(measured, "a"),
        b: heapMedian(measured, "b"),
        c: heapMedian(measured, "c"),
        d: heapMedian(measured, "d"),
      },
      defaultOn,
    },
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  const summary = [
    `session-stream: ${provider.id}, ${measured.length} rounds x ${TURNS} turns x ${provider.framesPerTurn} frames`,
    ...MODES.map((mode) => {
      const key: keyof Round = mode === "A" ? "a" : mode === "B" ? "b" : mode === "C" ? "c" : "d";
      const medianCpu = median(measured.map((value) => value[key].cpuMsPer1000Frames));
      return `  ${mode}${mode === "D" ? "" : " "} cpuMs/1000 frames ${medianCpu.toFixed(4)}`;
    }),
    `median D/A cpu ratio ${medianRatio.toFixed(3)}; frames/s D ${dFps.toFixed(1)} vs A ${aFps.toFixed(1)}`,
    `default-on rule: ${defaultOn ? "met" : "not met"}`,
    `wrote ${output}`,
  ].join("\n");
  process.stdout.write(summary + "\n");
}

async function main(): Promise<void> {
  const provider = chosenProvider();
  const mode = parseMode(option("mode"));
  if (process.argv.includes("--check")) {
    if (mode !== "D") throw new Error("--check needs --mode D");
    await checkNativeSession(provider);
    return;
  }
  const output = outputPath();
  if (mode === "D") {
    const refusal = await nativeSessionRefusal(provider);
    if (refusal !== undefined) {
      process.stderr.write(refusal + "\n");
      process.exitCode = 2;
      return;
    }
    await runMode(mode, output, provider);
    return;
  }
  if (mode !== undefined) {
    await runMode(mode, output, provider);
    return;
  }
  const rounds = Number(option("rounds") ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1)
    throw new Error(`--rounds takes a whole number of rounds, not ${option("rounds")}`);
  await runAll(rounds, output, provider);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) + "\n",
  );
  process.exitCode = 1;
}
