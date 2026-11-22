import type { CursorEnvelope } from "./contracts.ts";
import { storedIdentity, updateIdentity } from "./event-identity.ts";

/*
 * Where each frame the host sends stands against the SDK's own stored run events (ADR 0043,
 * amendment of 2026-11-22), so recovery after a crash adds exactly what ace's record lacks.
 */

/** How far ace's frames reach into one run's stored events. */
export interface Coverage {
  /** Every stored event up to this sequence is in ace's frames (or is bookkeeping). */
  through: number;
  /** Updates ace framed whose events the SDK has not stored yet, oldest first. */
  pending: string[];
}

/**
 * Pairs each update the host frames with the event the SDK stores for it, in either order the
 * SDK may do them (onDelta then store, or store then onDelta), so a frame can say exactly which
 * stored events it covers. Pairing is first in, first out by identity; bookkeeping events
 * (request, status), which no update has, cover themselves.
 */
export class EventCoverage {
  private through = 0;
  /** Content events stored before their update was framed. */
  private stored: { seq: number; identity: string }[] = [];
  private pending: string[] = [];
  private last = 0;
  private advance(): void {
    this.through = this.stored.length ? (this.stored[0]?.seq ?? 1) - 1 : this.last;
  }
  /** The SDK stored an event. */
  storedEvent(seq: number, message: unknown): void {
    this.last = Math.max(this.last, seq);
    const identity = storedIdentity(message);
    if (identity !== undefined) {
      if (this.pending[0] === identity) this.pending.shift();
      else if (this.stored.length < 1024) this.stored.push({ seq, identity });
    }
    this.advance();
  }
  /** The host framed an update. */
  framed(update: unknown): void {
    const identity = updateIdentity(update);
    if (identity === undefined) return;
    if (this.stored[0]?.identity === identity) this.stored.shift();
    else if (this.pending.length < 64) this.pending.push(identity);
    this.advance();
  }
  coverage(): Coverage {
    return { through: this.through, pending: [...this.pending] };
  }
}

/** Stored events seen per run, bounded: the host runs one at a time. */
const maxRuns = 64;

/** The host's coverage of every run it has seen events of, and the run being stored now. */
export class RunSeams {
  private runs = new Map<string, EventCoverage>();
  private current: string | undefined;
  private run(runId: string): EventCoverage {
    let coverage = this.runs.get(runId);
    if (!coverage) {
      coverage = new EventCoverage();
      this.runs.set(runId, coverage);
      for (const key of this.runs.keys()) {
        if (this.runs.size <= maxRuns) break;
        this.runs.delete(key);
      }
    }
    return coverage;
  }
  /** The SDK stored `message` as event `seq` of `runId`. */
  stored(runId: string, seq: number, message: unknown): void {
    this.current = runId;
    this.run(runId).storedEvent(seq, message);
  }
  /** A new send: until its run stores an event, no content belongs to an earlier run. */
  sending(): void {
    this.current = undefined;
  }
  /**
   * The stamp a frame carries. A content frame before its run is known (inside the SDK's send)
   * belongs to the run whose events are being stored; an update frame (`delta`) is paired with
   * its event first, so the stamp includes it.
   */
  stamp(
    kind: string,
    body: unknown,
    runId: string | undefined,
    sending: boolean,
  ): Partial<CursorEnvelope> {
    const content = ["delta", "delta-chunk", "shell-output", "blob"].includes(kind);
    const run = runId ?? (content && sending ? this.current : undefined);
    if (!run) return {};
    const coverage = this.run(run);
    if (kind === "delta") coverage.framed(body);
    const { through, pending } = coverage.coverage();
    return { runId: run, eventSeq: through, ...(pending.length ? { pendingEvents: pending } : {}) };
  }
}
