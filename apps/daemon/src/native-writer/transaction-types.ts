// SPDX-License-Identifier: Apache-2.0
//! The shapes the native transaction stack speaks: the addon's finish payload and handle, and
//! the shell's context and frame. Split from the class so each file holds one responsibility.
import type { NativeSqliteFailure } from "@ace/provider-kit/sqlite";
import type { Event } from "@ace/protocol";
import type { FailureReport, TransactionOutcome } from "../store-stream.ts";

export type NativeStep =
  | { kind: "publish"; from: number; to: number }
  | { kind: "settle"; id: number; how: "committed" | "rolledBack" };

export interface NativeFinish {
  ending: "released" | "committed" | "rolledBackToSavepoint" | "rolledBack";
  eventsLen: number;
  steps: NativeStep[];
  reports: NativeSqliteFailure[];
  error: NativeSqliteFailure | null;
  rolledBack: boolean;
}

/** The addon's `NativeTransactionStack` (`native/daemon/.../writer/transaction.rs`). */
export interface NativeStack {
  begin(own: number | null): number;
  noteEvents(len: number): void;
  succeed(frame: number): string;
  fail(frame: number): string;
  releaseRuns(frame: number): void;
  releaseWakes(frame: number): void;
  detachSink(): number[];
}

/** The methods this shell uses on the addon's database handle. */
export interface NativeStore {
  transactionStack(): NativeStack;
}

/**
 * The TypeScript state the shell keeps: the live buffer flush, the history path, the thread
 * cache, the read and sidebar caches, the written-thread set, the WAL wake, the counters, the
 * publication, the usage listeners and error reporting. `Store` supplies it; none of it is a
 * transaction position.
 */
export interface TransactionHost {
  flush(): void;
  installingHistory(): boolean;
  beginThreads(): void;
  discardThreads(): void;
  commitThreads(): void;
  endThreads(): void;
  /** Evict the written threads' read cache and clear the set. */
  evictWritten(): void;
  /** Bump the rollback generation and drop the sidebar cache (whole transaction). */
  topRolledBack(): void;
  /** The same, for one savepoint, plus the read cache. */
  nestedRolledBack(): void;
  wakeWal(): void;
  /** `transactions++` and `eventRows += rows`. */
  committed(rows: number): void;
  publish(events: Event[], report?: FailureReport): void;
  usage(): Iterable<() => void>;
  onError(error: unknown): void;
}

/** One top-level transaction's TypeScript state; nested frames share it. */
export interface Context {
  events: Event[];
  outcomes: Map<number, TransactionOutcome>;
}

/**
 * A transaction between `open` and `close`: the shell's frame handle (null when a history
 * install runs the body without a transaction), the context it belongs to, its own outcome id
 * and whether it opened the top level.
 */
export interface OpenFrame {
  token: number;
  frame: number | null;
  context: Context | null;
  own: number | undefined;
  outcome: TransactionOutcome | undefined;
  top: boolean;
}
