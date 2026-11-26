// SPDX-License-Identifier: Apache-2.0
//! The transaction stack behind `ACE_STORE_WRITER=transactions` (task 5.5; E5.1's shared stack).
//! Depth, savepoints, `BEGIN IMMEDIATE`, `RELEASE`, savepoint recovery, the doomed flag,
//! rollback, settlement positions and the publication order live in
//! `ace_store::writer::transaction`. This shell holds the `Event` objects and the settlement
//! callbacks, applies the returned `events_len` and `steps` exactly as given, and holds no
//! position of its own.
//!
//! E5.1 splits `transaction` into `open` and `close` so the Rust engine can run its body inside
//! the same context a JavaScript caller gets (before the body, to after its last step), and
//! releases each committed transaction's after-commit wakes after that transaction's own
//! publication - even when a listener throws.

import { appendFileSync } from "node:fs";
import { nativeCall, nativeHandle, sqliteError } from "@ace/provider-kit/sqlite";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import type { NativeSqliteFailure } from "@ace/provider-kit/sqlite";
import type { Event } from "@ace/protocol";
import {
  SettlementPass,
  settleOutcomes,
  type FailureReport,
  type TransactionOutcome,
} from "../store-stream.ts";
import type {
  Context,
  NativeFinish,
  NativeStack,
  NativeStore,
  OpenFrame,
  TransactionHost,
} from "./transaction-types.ts";

export type { OpenFrame, TransactionHost } from "./transaction-types.ts";

export class NativeTransactions {
  /** The database this shell's stack runs on, for the engine's bindings. */
  readonly db: DatabaseSync;
  private readonly stack: NativeStack;
  private readonly host: TransactionHost;
  /** Whether this store has written its evidence line (the proof's evidence file). */
  private evidenceWritten = false;
  /**
   * The open transactions, outermost first. Their event objects and settlement callbacks live
   * here, never in Rust. A committed transaction pops its context before publishing, so a
   * listener that appends starts a fresh top-level transaction as it does in the TypeScript.
   */
  private readonly contexts: Context[] = [];
  /** The open frames the Rust engine's ports hold between `open` and `close`. */
  private readonly openFrames = new Map<number, OpenFrame>();
  private nextOpen = 1;
  private nextOutcome = 1;
  /** The first nested exception that doomed the transaction (the TypeScript `doomed`). */
  private doomCause: unknown;
  private hasDoomCause = false;

  constructor(options: { db: DatabaseSync; host: TransactionHost }) {
    const handle = nativeHandle(options.db as unknown as object) as unknown as
      | NativeStore
      | undefined;
    if (!handle) throw new Error("ACE_STORE=native needs the store addon");
    this.stack = nativeCall(() => handle.transactionStack());
    this.host = options.host;
    this.db = options.db;
  }

  /** Whether this store has a top-level or nested transaction open. */
  get transactionOpen(): boolean {
    return this.contexts.length > 0;
  }

  /** The events a write added to the open transaction; a no-op outside one. */
  append(events: Event[]): void {
    const context = this.contexts.at(-1);
    if (context === undefined) return;
    context.events.push(...events);
    nativeCall(() => this.stack.noteEvents(context.events.length));
  }

  /** The engine's `appendEvents` port: a batch of events as JSON text, appended once. */
  appendEvents(json: string): void {
    this.append(JSON.parse(json) as Event[]);
  }

  transaction<T>(run: () => T, outcome?: TransactionOutcome): T {
    const frame = this.open(outcome);
    if (frame.frame === null) return run();
    let value: T | undefined;
    let thrown: unknown;
    let threw = false;
    try {
      value = run();
      if (value instanceof Promise) throw new Error("Store transactions must be synchronous");
    } catch (error) {
      threw = true;
      thrown = error;
    }
    // Exactly the TypeScript's precedence: `finishTop`/`finishNested` run before the body's
    // error is rethrown, so a rollback handling failure is what escapes.
    this.close(frame, threw ? { threw: true, error: thrown } : { threw: false });
    if (threw) throw thrown;
    return value as T;
  }

  /**
   * Flush, the history check, the context push (when it opens the top), the outcome's
   * registration, `stack.begin`, the evidence line and `beginThreads`.
   */
  open(outcome?: TransactionOutcome): OpenFrame {
    this.host.flush();
    if (this.host.installingHistory()) {
      // installHistory drains the buffer before it begins; a live write retries after it. The
      // bypass opens no frame and remembers nothing, so no map entry can outlive it.
      if (outcome) throw new Error("Store is busy");
      return {
        token: 0,
        frame: null,
        context: null,
        own: undefined,
        outcome: undefined,
        top: false,
      };
    }
    const top = this.contexts.length === 0;
    if (top) this.contexts.push({ events: [], outcomes: new Map() });
    const context = this.contexts.at(-1);
    if (context === undefined) throw new Error("Store transaction context is missing");
    const own = outcome === undefined ? undefined : this.register(context, outcome);
    let frame: number;
    try {
      frame = nativeCall(() => this.stack.begin(own ?? null));
    } catch (error) {
      if (own !== undefined) context.outcomes.delete(own);
      if (top) this.contexts.pop();
      throw error;
    }
    const open = this.remember({ frame, context, own, outcome, top });
    try {
      this.recordEvidence();
      if (top) this.host.beginThreads();
    } catch (error) {
      this.close(open, { threw: true, error });
      throw error;
    }
    return open;
  }

  /** `finishCall`, then the nested or top finish, then the transaction's wake release. */
  close(
    frame: OpenFrame | number,
    result: { threw: false } | { threw: true; error: unknown },
  ): void {
    const open = typeof frame === "number" ? this.openFrames.get(frame) : frame;
    if (open === undefined) return;
    this.openFrames.delete(open.token);
    if (open.frame === null) return;
    const { frame: id, context, own, outcome, top } = open;
    if (context === null) return;
    let finish: NativeFinish;
    if (result.threw) {
      finish = this.finishCall(id, false);
      // The frame's own outcome never settled on a failure: the caller sees the error.
      if (own !== undefined) context.outcomes.delete(own);
      if (!top && finish.ending === "rolledBack") this.rememberDoom(result.error);
    } else {
      finish = this.finishCall(id, true);
      if (!top && finish.error !== null && finish.ending === "rolledBack")
        this.rememberDoom(sqliteError(finish.error));
    }
    const failure =
      finish.error === null || result.threw ? undefined : this.finishError(finish.error);
    if (top) this.finishTop(finish, context, own, outcome, id);
    else this.finishNested(finish, context);
    if (result.threw) return;
    if (failure !== undefined) throw failure;
  }

  private remember(open: Omit<OpenFrame, "token">): OpenFrame {
    const frame: OpenFrame = { token: this.nextOpen++, ...open };
    this.openFrames.set(frame.token, frame);
    return frame;
  }

  private register(context: Context, outcome: TransactionOutcome): number {
    const id = this.nextOutcome;
    this.nextOutcome += 1;
    context.outcomes.set(id, outcome);
    return id;
  }

  /** Appends one line to `ACE_STORE_WRITER_EVIDENCE` on the first native begin, when set. */
  private recordEvidence(): void {
    if (this.evidenceWritten) return;
    const path = process.env.ACE_STORE_WRITER_EVIDENCE;
    if (path === undefined) return;
    appendFileSync(path, `${process.pid} transactions\n`);
    this.evidenceWritten = true;
  }

  private finishCall(frame: number, succeeded: boolean): NativeFinish {
    const text = nativeCall(() => (succeeded ? this.stack.succeed(frame) : this.stack.fail(frame)));
    return JSON.parse(text) as NativeFinish;
  }

  private finishTop(
    finish: NativeFinish,
    context: Context,
    own: number | undefined,
    outcome: TransactionOutcome | undefined,
    frame: number,
  ): void {
    try {
      if (finish.ending === "committed") {
        this.host.commitThreads();
        this.host.committed(context.events.length);
        this.host.evictWritten();
        this.host.wakeWal();
        // The thread cache ends before the post-commit pass, as the TypeScript's finally does.
        this.host.endThreads();
        // The SQL transaction is over: a listener that writes now opens a new top-level one.
        this.pop(context);
        this.resetDoom();
        this.publishSteps(finish, context, own, outcome, frame);
      } else {
        if (finish.rolledBack) this.host.topRolledBack();
        // Rust has reset its stack: close the JS side before a callback can re-enter and write.
        this.pop(context);
        this.resetDoom();
        this.rollbackSteps(finish, context);
        this.report(finish.reports);
        this.host.endThreads();
      }
    } finally {
      this.pop(context);
      this.resetDoom();
    }
  }

  private finishNested(finish: NativeFinish, context: Context): void {
    if (finish.ending === "released") {
      context.events.length = finish.eventsLen;
      return;
    }
    if (finish.rolledBack) {
      this.host.discardThreads();
      this.host.nestedRolledBack();
    }
    this.rollbackSteps(finish, context);
    this.report(finish.reports);
  }

  /** Remove `context` when it is still the innermost one; a reentrant pass pops its own. */
  private pop(context: Context): void {
    if (this.contexts.at(-1) === context) this.contexts.pop();
  }

  private resetDoom(): void {
    this.doomCause = undefined;
    this.hasDoomCause = false;
  }

  /** A whole transaction or a savepoint rolled back: settle each outcome in its own try. */
  private rollbackSteps(finish: NativeFinish, context: Context): void {
    context.events.length = finish.eventsLen;
    for (const step of finish.steps) {
      if (step.kind !== "settle") continue;
      const outcome = context.outcomes.get(step.id);
      context.outcomes.delete(step.id);
      if (outcome === undefined) continue;
      settleOutcomes([{ outcome }], step.how, (error) => this.host.onError(error));
    }
  }

  /** The committed pass: the outer outcome at the off path's position, then the rest. */
  private publishSteps(
    finish: NativeFinish,
    context: Context,
    own: number | undefined,
    outcome: TransactionOutcome | undefined,
    frame: number,
  ): void {
    const pass = new SettlementPass((error) => this.host.onError(error));
    const report: FailureReport = (error) => pass.report(error);
    try {
      // The engine's committed decisions (a promoted actor, an evicted victim) are visible to
      // every commit listener, which is the order the TypeScript's eviction at the call had.
      try {
        nativeCall(() => this.stack.releaseRuns(frame));
      } catch (error) {
        pass.report(error as Error);
      }
      // A publishing outer outcome settles first; a reservation (non-publishing) settles last,
      // after the usage listeners, exactly as the TypeScript's two guards do.
      if (outcome?.publishes) pass.step(() => outcome.committed(report));
      if (own !== undefined) context.outcomes.delete(own);
      for (const step of finish.steps) {
        if (step.kind === "publish") {
          pass.step(() => this.host.publish(context.events.slice(step.from, step.to), report));
          continue;
        }
        if (step.id === own) continue;
        const settled = context.outcomes.get(step.id);
        context.outcomes.delete(step.id);
        if (settled === undefined) continue;
        settleOutcomes([{ outcome: settled }], step.how, (error) => this.host.onError(error), pass);
      }
      for (const listener of this.host.usage()) {
        try {
          listener();
        } catch (error) {
          try {
            this.host.onError(error);
          } catch {
            /* committed */
          }
        }
      }
      if (outcome && !outcome.publishes) pass.step(() => outcome.committed(report));
    } finally {
      // The frame's wakes run only now, after every publish and settlement of its own
      // transaction: a listener or settlement that throws never strands them.
      try {
        nativeCall(() => this.stack.releaseWakes(frame));
      } catch (error) {
        this.host.onError(error);
      }
    }
    pass.rethrow();
  }

  /** Recovery failures: report, never throw over the caller's own error. */
  private report(reports: readonly NativeSqliteFailure[]): void {
    for (const failure of reports) {
      try {
        this.host.onError(sqliteError(failure));
      } catch {
        /* The caller rethrows its own error. */
      }
    }
  }

  private rememberDoom(error: unknown): void {
    if (this.hasDoomCause) return;
    this.hasDoomCause = true;
    this.doomCause = error;
  }

  private finishError(failure: NativeSqliteFailure): Error {
    if (failure.kind === "doomed")
      return new Error("A failed step could not be undone, so the transaction rolled back", {
        cause: this.doomCause,
      });
    return sqliteError(failure);
  }
}
