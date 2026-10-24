import { z } from "zod";

const NativeTiming = z.object({
  elapsedMs: z.number().finite().nonnegative().optional(),
  timings: z.record(z.string(), z.number().finite().nonnegative()).optional(),
  state: z
    .object({ timings: z.record(z.string(), z.number().finite().nonnegative()).optional() })
    .optional(),
});
const NativeFailure = z.object({ error: z.object({ code: z.string() }) });
const phaseNames = new Set([
  "sessionMs",
  "windowsMs",
  "actionMs",
  "guardMs",
  "betweenSettleMs",
  "finalSettleMs",
  "observationMs",
  "walkMs",
  "fetchMs",
  "actionsMs",
  "describeMs",
  "screenshotMs",
  "events",
  "visited",
]);

const duration = (start: number, finish: number) => Math.max(0, finish - start);

/** Durations only. Never includes tool arguments, window titles, text or screenshots. */
export interface ComputerRequestTiming {
  op: string;
  app?: string;
  outcome: "ok" | "error" | "cancelled" | "timeout";
  queueMs: number;
  startupMs: number;
  helperMs: number;
  decodeMs: number;
  totalMs: number;
  native?: {
    elapsedMs?: number;
    phases: Record<string, number>;
    observation: Record<string, number>;
  };
}

/** One request's clock is injected at the process boundary. No timer or global clock here. */
export class ComputerRequestSpan {
  private readonly op: string;
  private readonly now: () => number;
  private readonly queued: number;
  private picked: number | undefined;
  private sent: number | undefined;
  private received: number | undefined;
  private decoded: number | undefined;
  private native: ComputerRequestTiming["native"];
  private failed = false;

  constructor(op: string, now: () => number) {
    this.op = op;
    this.now = now;
    this.queued = now();
  }

  stamp(): number {
    return this.now();
  }
  dequeue(): void {
    this.picked = this.now();
  }
  ready(): void {
    this.sent = this.now();
  }

  reply(at: number, result: unknown): void {
    this.received = at;
    this.failed = NativeFailure.safeParse(result).success;
    const parsed = NativeTiming.safeParse(result);
    if (parsed.success) {
      const filter = (values: Record<string, number> | undefined) =>
        Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => phaseNames.has(name)));
      this.native = {
        ...(parsed.data.elapsedMs !== undefined ? { elapsedMs: parsed.data.elapsedMs } : {}),
        phases: filter(parsed.data.timings),
        observation: filter(parsed.data.state?.timings),
      };
    }
    this.decoded = this.now();
  }

  finish(outcome: ComputerRequestTiming["outcome"]): ComputerRequestTiming {
    const end = this.now();
    return {
      op: this.op,
      outcome: outcome === "ok" && this.failed ? "error" : outcome,
      queueMs: duration(this.queued, this.picked ?? end),
      startupMs: this.picked === undefined ? 0 : duration(this.picked, this.sent ?? end),
      helperMs: this.sent === undefined ? 0 : duration(this.sent, this.received ?? end),
      decodeMs: this.received === undefined ? 0 : duration(this.received, this.decoded ?? end),
      totalMs: duration(this.queued, end),
      ...(this.native ? { native: this.native } : {}),
    };
  }
}
