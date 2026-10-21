import { parentPort, workerData } from "node:worker_threads";
import { Session } from "node:inspector";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { createStallDetector } from "./stall-detector.ts";
import { namesStall, pausedStack, ScriptParsed, type StallReport } from "./stall-report.ts";

/**
 * Watches the daemon's main thread from its own thread. While the heartbeat keeps changing it
 * only reads one shared integer per check. When the heartbeat stops, it writes what it knows to
 * disk (a frozen daemon may be killed before it can log) and asks the main thread for its
 * JavaScript stack through the inspector, then lets it run on.
 */
const input = z
  .object({
    heartbeat: z.instanceof(Int32Array),
    pid: z.number().int().positive(),
    reportPath: z.string().min(1),
    checkMs: z.number().int().positive(),
    thresholdMs: z.number().int().positive(),
    repeatMs: z.number().int().positive(),
    maxCaptures: z.number().int().positive(),
    cooldownMs: z.number().int().nonnegative(),
  })
  .parse(workerData);
const port = parentPort;
if (!port) throw new Error("The stall watchdog runs in a worker thread");
const detector = createStallDetector(input);
let report: StallReport | undefined;
let looking: Session | undefined;
let finishWhenAnswered = false;

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
      if (report && (caught || !report.caught))
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
setInterval(() => {
  const now = performance.now();
  const beat = Atomics.load(input.heartbeat, 0);
  const observed = detector.observe(now, beat);
  if (observed.type === "healthy") return;
  if (observed.type === "recovered") {
    if (report) persist({ ...report, silentMs: observed.silentMs, ended: true });
    if (looking) finishWhenAnswered = true;
    else finish();
    return;
  }
  if (!observed.capture) return;
  persist({
    pid: input.pid,
    silentSince: Math.max(0, Math.round(Date.now() - observed.silentMs)),
    silentMs: observed.silentMs,
    caught: report?.caught ?? false,
    stack: report?.stack ?? [],
    ended: false,
    ...(report?.answerMs === undefined ? {} : { answerMs: report.answerMs }),
  });
  look(now, beat);
}, input.checkMs);
