/**
 * E3.0d: the session bench. It drives the Pi adapter against the synthetic JSONL peer in
 * `session-stream/pi.ts` and reports the CPU cost of the frame path:
 *
 *   cpuMsPer1000Frames = (user + system microseconds over the ten turns) / 1000
 *                        / (frames delivered / 1000)
 *
 * `process.cpuUsage()` covers every thread of the process, so a native addon's tokio threads
 * count too. Modes:
 *
 *   A  off
 *   B  ACE_TRANSLATORS=pi
 *   C  B + ACE_STORE=native ACE_SUPERVISOR=native
 *   D  C + ACE_SESSIONS=pi (needs E3-pi.2's native session and its evidence line)
 *
 * Every mode runs in its own process. A full run measures three rounds of A B C D, discards a
 * round whose one-minute load average differs by more than 2x between its A and D runs, and
 * reports the median D/A ratio. Pi may be default-on only when that median is <= 1.00 and D's
 * median frames per second is at least A's (the owner's rule, porting-guide E3.0d step 6).
 *
 *   bun apps/daemon/bench/session-stream.ts [--rounds 3] [--output file]
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

type Mode = "A" | "B" | "C" | "D";
const MODES: readonly Mode[] = ["A", "B", "C", "D"];
const TURNS = 10;
/** 2,000 assistant deltas, one message end, one turn end, the response, and the prompt's send. */
const FRAMES_PER_TURN = 2_000 + 2 + 1 + 1;
/** The owner's rule: a switch defaults on only when this bench shows it no slower than off. */
const DEFAULT_ON_MAX_RATIO = 1.0;
/** A round whose A and D one-minute load averages differ by more than this is rerun. */
const MAX_LOAD_SPREAD = 2;
/** Never start a measurement while the machine is busy (the brief's one-bench-at-a-time gate). */
const LOAD_LIMIT = 60;

const script = fileURLToPath(import.meta.url);
const fake = fileURLToPath(new URL("./session-stream/pi.ts", import.meta.url));

const MODE_SWITCHES: Readonly<Record<Mode, Readonly<Record<string, string>>>> = {
  A: {},
  B: { ACE_TRANSLATORS: "pi" },
  C: { ACE_TRANSLATORS: "pi", ACE_STORE: "native", ACE_SUPERVISOR: "native" },
  D: {
    ACE_TRANSLATORS: "pi",
    ACE_STORE: "native",
    ACE_SUPERVISOR: "native",
    ACE_SESSIONS: "pi",
  },
};
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
  provider: z.literal("pi"),
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

function outputPath(): string {
  return option("output") ?? join(tmpdir(), "ace-session-stream-bench.json");
}

/** Each mode is a fresh process, so the switches are fixed before any module reads them. */
function applyMode(mode: Mode, evidence: string): void {
  for (const key of SWITCH_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(MODE_SWITCHES[mode])) process.env[key] = value;
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
 * The native Pi facade is absent until E3-pi.2. Its binding exports `PiSessionNative`; checking
 * that in a dedicated process keeps the addon out of any process that later opens a session.
 * Without it, mode D would silently measure the TypeScript session, so it refuses instead.
 */
async function checkNativePiSession(): Promise<void> {
  applyMode("D", join(tmpdir(), "ace-session-bench-evidence-check.jsonl"));
  if (process.env.ACE_SESSIONS !== "pi")
    throw new Error("the native Pi session check needs ACE_SESSIONS=pi");
  const { sessionsAddonPath } = await import("@ace/provider-kit/native-switches");
  const addon = sessionsAddonPath();
  if (!existsSync(addon)) {
    process.stderr.write(
      `mode D is refused: ACE_SESSIONS=pi needs the sessions addon at ${addon} exporting ` +
        "PiSessionNative (E3-pi.2), and no such file exists; build native/daemon with " +
        "cargo build --release. Nothing is measured, so the TypeScript session is never " +
        "mistaken for the native path.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const module = { exports: {} as Record<string, unknown> };
    process.dlopen(module, addon);
    if (typeof module.exports.PiSessionNative !== "function") {
      process.stderr.write(
        `mode D is refused: ACE_SESSIONS=pi needs PiSessionNative in the sessions addon at ` +
          `${addon} (E3-pi.2), and this build does not export it. Nothing is measured, so the ` +
          "TypeScript session is never mistaken for the native path.\n",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `mode D is refused: the sessions addon at ${addon} could not be loaded ` +
        `(${error instanceof Error ? error.message : String(error)}); ACE_SESSIONS=pi needs a ` +
        "working native Pi session (E3-pi.2).\n",
    );
    process.exitCode = 2;
  }
}

/** Why mode D is unavailable, or undefined when the native Pi session is present. */
async function nativePiSessionRefusal(): Promise<string | undefined> {
  const child = spawn(process.execPath, [script, "--mode", "D", "--check"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let message = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    message += chunk.toString();
  });
  const code = await exitCode(child);
  if (code === 0) return undefined;
  return message.trim() || `the native Pi session check failed (exit ${code})`;
}

async function runMode(mode: Mode, output: string): Promise<void> {
  await waitForLoad();
  const home = await mkdtemp(join(tmpdir(), `ace-session-bench-${mode}-`));
  const evidencePath = join(home, "evidence.jsonl");
  try {
    await writeFile(evidencePath, "");
    applyMode(mode, evidencePath);
    const { sessionFixture } =
      await import("../../../packages/adapter-pi/src/testing/native-history.ts");
    const sourcePath = join(home, "source.jsonl");
    // Pi's open reads the saved history's header, so the fake's get_state points at this file.
    await writeFile(sourcePath, sessionFixture(home, "bench", 3));
    const [{ createPiAdapter, createPiTranslator }, { spawnTextSupervised }, { ThreadId }] =
      await Promise.all([
        import("@ace/adapter-pi"),
        import("@ace/provider-kit/process"),
        import("@ace/protocol"),
      ]);
    if (typeof globalThis.gc !== "function")
      throw new Error("the heap record needs two forced GCs; run with --expose-gc");

    const threadId = ThreadId.parse("pi-bench");
    const translator = createPiTranslator({ threadId, rootKey: "root" });
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
      env: { FAKE_PI_HOME: home },
      signal: controller.signal,
      onFrame,
      onExit: () => {},
    };
    const adapter = createPiAdapter({
      sessionReferenceDir: join(home, "references"),
      cli: {
        installed: true,
        path: "synthetic-pi",
        version: "0.85.1",
        auth: "unknown",
        loginHint: "none",
      },
      runtime: {
        spawn: (options) =>
          spawnTextSupervised({
            ...options,
            command: process.execPath,
            args: [fake, ...(options.args ?? [])],
          }),
      },
    });
    const session = await adapter.openSession(ctx);
    try {
      // The window is the ten turns: the open handshake is not part of the frame path's cost.
      frames = 0;
      const load1 = loadavg()[0] ?? 0;
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      for (let turn = 1; turn <= TURNS; turn++)
        await session.send([{ type: "text", text: `bench turn ${turn}` }], "queue");
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      globalThis.gc();
      globalThis.gc();
      const heapUsed = process.memoryUsage().heapUsed;

      const expected = TURNS * FRAMES_PER_TURN;
      if (frames !== expected)
        throw new Error(`mode ${mode} delivered ${frames} frames; the fake prints ${expected}`);
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

async function runChild(mode: Mode): Promise<ModeResult> {
  const output = join(tmpdir(), `ace-session-bench-${mode}-${process.pid}-${Date.now()}.json`);
  try {
    const child = spawn(
      process.execPath,
      ["--expose-gc", script, "--mode", mode, "--output", output],
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

async function runAll(rounds: number, output: string): Promise<void> {
  const refusal = await nativePiSessionRefusal();
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
    const a = await runChild("A");
    const b = await runChild("B");
    const c = await runChild("C");
    const d = await runChild("D");
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
    provider: "pi",
    generatedAt: new Date().toISOString(),
    machine: { cpus: cpus().length, load1: loadavg()[0] ?? 0 },
    turns: TURNS,
    framesPerTurn: FRAMES_PER_TURN,
    rounds: measured,
    aggregation: {
      rule:
        "median(D.cpuMsPer1000Frames / A.cpuMsPer1000Frames) <= 1.00 and " +
        "median(D frames/s) >= median(A frames/s)",
      discardedRounds: attempts - measured.length,
      roundRatios: ratios,
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
    `session-stream: pi, ${measured.length} rounds x ${TURNS} turns x ${FRAMES_PER_TURN} frames`,
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
  const mode = parseMode(option("mode"));
  if (process.argv.includes("--check")) {
    if (mode !== "D") throw new Error("--check needs --mode D");
    await checkNativePiSession();
    return;
  }
  const output = outputPath();
  if (mode === "D") {
    const refusal = await nativePiSessionRefusal();
    if (refusal !== undefined) {
      process.stderr.write(refusal + "\n");
      process.exitCode = 2;
      return;
    }
    await runMode(mode, output);
    return;
  }
  if (mode !== undefined) {
    await runMode(mode, output);
    return;
  }
  const rounds = Number(option("rounds") ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1)
    throw new Error(`--rounds takes a whole number of rounds, not ${option("rounds")}`);
  await runAll(rounds, output);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) + "\n",
  );
  process.exitCode = 1;
}
