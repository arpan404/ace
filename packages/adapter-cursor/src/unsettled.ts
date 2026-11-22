import { z } from "zod";
import type { SessionContext } from "@ace/engine-api";

/*
 * What the daemon's committed Cursor frames lack of the open turn (ADR 0043, amendment of
 * 2026-11-22): the runs it started and never saw end, how far into each run's SDK-stored events
 * the frames reach (event-identity.ts), and a send attempted with no sign Cursor had it. The
 * daemon folds its frames through this at open and passes the result to the reopened host.
 */

/** The fields of a Cursor frame that say how far the daemon's record of a run reaches. */
const Progress = z.object({
  kind: z.string(),
  operationId: z.string().min(1).max(512),
  commandId: z.string().min(1).max(512).optional(),
  segment: z.number().int().nonnegative(),
  runId: z.string().min(1).max(512).optional(),
  eventSeq: z.number().int().nonnegative().optional(),
  pendingEvents: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(64)
    .optional(),
  body: z.unknown(),
});
const Attempted = z.object({ attemptedAt: z.number().finite().nonnegative() });
const Admitted = z.object({ nativeRunId: z.string().min(1).max(512) });
const Settled = z.object({ settled: z.literal(true) });
/** What a reopened Cursor host reads back from its store: see `SessionContext.resume`. */
export type Unsettled = NonNullable<NonNullable<SessionContext["resume"]>["unsettled"]>;
/** How far ace's record of one run reaches into the SDK's stored events. */
interface Seam {
  through: number;
  pending: string[];
}
/** Folds committed frames, in order, into what the open turn's record lacks. Pure. */
export class UnsettledRuns {
  private runs = new Map<string, Seam>();
  private attempt: Unsettled["attempt"];
  private current: string | undefined;
  /**
   * A frame of `runId` stamped against the SDK's stored events: each stamp says all there is,
   * so the newest one stands, live or recovered.
   */
  private advance(
    runId: string,
    eventSeq: number | undefined,
    pending: string[] | undefined,
  ): void {
    const seam = this.runs.get(runId) ?? { through: 0, pending: [] };
    if (eventSeq === undefined || eventSeq < seam.through) {
      this.runs.set(runId, seam);
      return;
    }
    this.runs.set(runId, { through: eventSeq, pending: pending ?? [] });
  }
  add(data: unknown): void {
    const frame = Progress.safeParse(data);
    if (!frame.success) return;
    const { kind, runId, eventSeq, pendingEvents, body } = frame.data;
    if (kind === "send") {
      const attempted = Attempted.safeParse(body);
      this.attempt = attempted.success
        ? {
            operationId: frame.data.operationId,
            ...(frame.data.commandId ? { commandId: frame.data.commandId } : {}),
            segment: frame.data.segment,
            at: attempted.data.attemptedAt,
          }
        : undefined;
      return;
    }
    if (kind === "segment") {
      this.attempt = undefined;
      const admitted = Admitted.safeParse(body);
      const id = admitted.success ? admitted.data.nativeRunId : runId;
      if (id) {
        this.current = id;
        this.advance(id, eventSeq, pendingEvents);
      }
      return;
    }
    // A send Cursor refused or failed is the session's own error, already in the record.
    if (kind === "error" && this.attempt?.operationId === frame.data.operationId)
      this.attempt = undefined;
    const id = runId ?? this.current;
    if (!id) return;
    const ends =
      kind === "result" ||
      kind === "recovery" ||
      ((kind === "error" || kind === "cancel") && Settled.safeParse(body).success);
    if (ends) {
      this.runs.delete(id);
      if (id === this.current) this.current = undefined;
      return;
    }
    if (!runId || eventSeq === undefined) return;
    // Output of the attempted send names its run: Cursor had it.
    if (this.attempt?.operationId === frame.data.operationId) {
      this.attempt = undefined;
      this.current = runId;
    }
    this.advance(runId, eventSeq, pendingEvents);
  }
  result(): Unsettled {
    const runs = [...this.runs].slice(-64).map(([runId, seam]) => {
      const run: Unsettled["runs"][number] = { runId, through: seam.through };
      if (seam.pending.length) run.pending = seam.pending;
      return run;
    });
    return { runs, ...(this.attempt ? { attempt: this.attempt } : {}) };
  }
}
