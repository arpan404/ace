import { parentPort, workerData } from "node:worker_threads";
import { Session } from "node:inspector";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import * as z from "zod/mini";
import { createStallDetector } from "./stall-detector.ts";
import { namesStall, pausedStack, ScriptParsed, type StallReport } from "./stall-report.ts";

/**
 * Watches the daemon's main thread from its own thread. While the heartbeat keeps changing it
 * reads one shared integer and the process CPU clock per check, and stats one directory a
 * second on the shared thread pool. When the heartbeat stops, it writes what it knows to disk
 * (a frozen daemon may be killed before it can log) and asks the main thread for its JavaScript
 * stack through the inspector, then lets it run on.
 */
const positive = () => z.int().check(z.positive());
const input = z
  .object({
    heartbeat: z.instanceof(Int32Array),
    pid: positive(),
    reportPath: z.string().check(z.minLength(1)),
    checkMs: positive(),
    thresholdMs: positive(),
    repeatMs: positive(),
    maxCaptures: positive(),
    cooldownMs: z.int().check(z.nonnegative()),
    ioEveryMs: positive(),
    ioThresholdMs: positive(),
  })
  .parse(workerData);
const port = parentPort;
if (!port) throw new Error("The stall watchdog runs in a worker thread");
const detector = createStallDetector(input);
let report: StallReport | undefined;
let looking: Session | undefined;
let finishWhenAnswered = false;
/** Process CPU and watchdog lateness are measured from the main thread's latest heartbeat. */
let seenBeat = Atomics.load(input.heartbeat, 0);
let healthyCpu = process.cpuUsage();
let lateMs = 0;
let checkedAt = performance.now();
let ioSince: number | undefined;
let ioNextAt = 0;
let ioWrittenAt = 0;

function persist(next: StallReport): void {
  report = next;
  const partial = `${input.reportPath}.partial`;
  try {
    writeFileSync(partial, JSON.stringify(next));
    renameSync(partial, input.reportPath);
  } catch {
    // A report that cannot be written is still sent to the main thread when it recovers.
  }
}
function finish(): void {
  if (!report) return;
  port?.postMessage(report);
  rmSync(input.reportPath, { force: true });
  report = undefined;
  finishWhenAnswered = false;
}
function context(now: number) {
  const cpu = process.cpuUsage(healthyCpu);
  return {
    cpuMs: Math.round((cpu.user + cpu.system) / 1_000),
    watchdogLateMs: Math.round(lateMs),
    load: Math.round((loadavg()[0] ?? 0) * 10) / 10,
    ...(ioSince === undefined ? {} : { ioWaitMs: Math.round(now - ioSince) }),
  };
}
function look(asked: number, beat: number): void {
  if (looking) return;
  const session = new Session();
  looking = session;
  const scripts = new Map<string, string>();
  const done = () => {
    session.disconnect();
    looking = undefined;
    if (finishWhenAnswered) finish();
  };
  session.on("Debugger.scriptParsed", (message) => {
    const script = ScriptParsed.safeParse(message.params);
    if (script.success && script.data.url) scripts.set(script.data.scriptId, script.data.url);
  });
  session.once("Debugger.paused", (message) => {
    // Paused before its next heartbeat: still inside the stall, so this is where it was stuck.
    // Otherwise the stall ended first and the stack is unrelated work.
    const paused = pausedStack(message.params, scripts);
    const caught = Atomics.load(input.heartbeat, 0) === beat && namesStall(paused);
    const stack = caught ? paused : [];
    session.post("Debugger.resume", () => {
      if (report?.kind === "main" && (caught || !report.caught))
        persist({
          ...report,
          caught,
          stack,
          answerMs: Math.max(0, Math.round(performance.now() - asked)),
        });
      done();
    });
  });
  try {
    session.connectToMainThread();
    // Both requests go at once: the main thread handles them in order the moment it next runs
    // JavaScript. Waiting for the first answer would let it slip past that moment.
    session.post("Debugger.enable");
    session.post("Debugger.pause", (error) => error && done());
  } catch {
    done();
  }
}
/** One cheap call through the thread pool the daemon's async file I/O and log writes share. */
function probeThreadPool(now: number): void {
  if (ioSince !== undefined || now < ioNextAt) return;
  ioSince = now;
  void stat(dirname(input.reportPath))
    .catch(() => undefined)
    .then(() => {
      const answered = performance.now();
      if (report?.kind === "io" && ioSince !== undefined) {
        persist({ ...report, silentMs: Math.round(answered - ioSince), ended: true });
        finish();
      }
      ioSince = undefined;
      ioNextAt = answered + input.ioEveryMs;
    });
}
setInterval(() => {
  const now = performance.now();
  lateMs = Math.max(lateMs, now - checkedAt - input.checkMs);
  checkedAt = now;
  probeThreadPool(now);
  const beat = Atomics.load(input.heartbeat, 0);
  if (beat !== seenBeat) {
    seenBeat = beat;
    healthyCpu = process.cpuUsage();
    lateMs = 0;
  }
  const observed = detector.observe(now, beat);
  if (observed.type === "recovered") {
    if (report?.kind === "main") persist({ ...report, silentMs: observed.silentMs, ended: true });
    if (looking) finishWhenAnswered = true;
    else if (report?.kind === "main") finish();
  }
  if (observed.type !== "stalled") {
    // The main thread runs, but the thread pool does not answer: its logs and file writes wait.
    const ioWait = ioSince === undefined ? 0 : now - ioSince;
    if (
      ioSince !== undefined &&
      ioWait >= input.ioThresholdMs &&
      (report === undefined || (report.kind === "io" && now - ioWrittenAt >= input.repeatMs))
    ) {
      ioWrittenAt = now;
      persist({
        pid: input.pid,
        kind: "io",
        silentSince: Math.max(0, Math.round(Date.now() - ioWait)),
        silentMs: Math.round(ioWait),
        caught: false,
        stack: [],
        ended: false,
        ...context(now),
      });
    }
    return;
  }
  if (!observed.capture) return;
  const previous = report?.kind === "main" ? report : undefined;
  persist({
    pid: input.pid,
    kind: "main",
    silentSince: Math.max(0, Math.round(Date.now() - observed.silentMs)),
    silentMs: observed.silentMs,
    caught: previous?.caught ?? false,
    stack: previous?.stack ?? [],
    ended: false,
    ...context(now),
    ...(previous?.answerMs === undefined ? {} : { answerMs: previous.answerMs }),
  });
  look(now, beat);
}, input.checkMs);
