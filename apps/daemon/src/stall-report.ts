import { z } from "zod";

const maxFrames = 32;
export const StallFrame = z.object({
  fn: z.string().max(512),
  url: z.string().max(2048),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
export type StallFrame = z.infer<typeof StallFrame>;
/** What the watchdog knows about one stall. Written to disk while it lasts. */
export const StallReport = z.object({
  pid: z.number().int().positive(),
  /**
   * `main`: the main thread ran no timer. `io`: a file-system call on Node's shared thread pool
   * (async fs, dns, zlib; the log writes there) went unanswered while the main thread ran.
   */
  kind: z.enum(["main", "io"]).default("main"),
  /** Epoch milliseconds when the stalled side was last seen making progress. */
  silentSince: z.number().nonnegative(),
  /** How long it had been stalled at the latest update. */
  silentMs: z.number().int().nonnegative(),
  /**
   * Process CPU time used meanwhile. Close to `silentMs`: the thread was computing. Far below:
   * it was waiting (a SQLite lock's busy wait, sync I/O) or the machine gave it no CPU.
   */
  cpuMs: z.number().int().nonnegative().optional(),
  /** How late the watchdog's own checks ran: large when the whole process got no CPU. */
  watchdogLateMs: z.number().int().nonnegative().optional(),
  /** The machine's one-minute load average. */
  load: z.number().nonnegative().optional(),
  /** Age of the thread pool probe still unanswered, when there is one. */
  ioWaitMs: z.number().int().nonnegative().optional(),
  /**
   * The main thread ran JavaScript again while the stall still lasted, so `stack` is where it
   * was stuck. False with an empty stack: it never left native code (SQLite, sync I/O) while
   * the watchdog looked.
   */
  caught: z.boolean(),
  /** From asking the main thread for its stack to getting it. Long when it sat in native code. */
  answerMs: z.number().int().nonnegative().optional(),
  stack: z.array(StallFrame).max(maxFrames),
  /** The main thread came back: `silentMs` is the whole stall. */
  ended: z.boolean(),
});
export type StallReport = z.infer<typeof StallReport>;

const PausedEvent = z
  .object({
    callFrames: z.array(
      z
        .object({
          functionName: z.string(),
          url: z.string().optional(),
          location: z
            .object({
              scriptId: z.string(),
              lineNumber: z.number().int().nonnegative(),
              columnNumber: z.number().int().nonnegative().optional(),
            })
            .loose(),
        })
        .loose(),
    ),
  })
  .loose();
export const ScriptParsed = z.object({ scriptId: z.string(), url: z.string() }).loose();

/** The paused main thread's JavaScript stack, innermost first, with 1-based positions. */
export function pausedStack(params: unknown, scripts: ReadonlyMap<string, string>): StallFrame[] {
  const parsed = PausedEvent.safeParse(params);
  if (!parsed.success) return [];
  return parsed.data.callFrames.slice(0, maxFrames).map((frame) => ({
    fn: frame.functionName.slice(0, 512),
    url: (scripts.get(frame.location.scriptId) || frame.url || "").slice(0, 2048),
    line: frame.location.lineNumber + 1,
    column: (frame.location.columnNumber ?? 0) + 1,
  }));
}

/**
 * Whether a paused stack can show where a stall was. A stall in native code (one long SQLite
 * statement, sync I/O) is answered at the next JavaScript the thread runs: usually its caller
 * carrying on, but when the caller had already returned, only the runtime's own event-loop
 * frames run next, and they name nothing.
 */
export function namesStall(stack: readonly StallFrame[]): boolean {
  return stack.some((frame) => frame.url !== "" && !frame.url.startsWith("node:"));
}

export function describeFrame(frame: StallFrame): string {
  return `${frame.fn || "(anonymous)"} (${frame.url || "<unknown>"}:${frame.line}:${frame.column})`;
}

/** Log fields naming where a stall happened. */
export function stallFields(report: StallReport): Array<readonly [string, unknown]> {
  const context: Array<readonly [string, unknown]> = [
    ["silentMs", report.silentMs],
    ["ended", report.ended],
    ["cpuMs", report.cpuMs ?? null],
    ["watchdogLateMs", report.watchdogLateMs ?? null],
    ["load", report.load ?? null],
    ["ioWaitMs", report.ioWaitMs ?? null],
  ];
  if (report.kind === "io") return [["kind", "io"], ...context];
  return [
    ["kind", "main"],
    ...context,
    ["caught", report.caught],
    ["answerMs", report.answerMs ?? null],
    [
      "at",
      report.stack[0]
        ? describeFrame(report.stack[0])
        : report.ended
          ? "unknown: the stall ended before its stack was read"
          : "native code: no JavaScript ran while the watchdog looked",
    ],
    ["stack", report.stack.slice(0, 16).map(describeFrame)],
  ];
}
