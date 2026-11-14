import type { DatabaseSync } from "node:sqlite";
import type { StoredTrust } from "./stored-decode.ts";
import { openStoredTrust, readStoredTrust, type OpenedTrust } from "./stored-shape.ts";
import {
  runInProgress,
  scheduleTrustPass,
  startStoredTrustPass,
  type TrustPassScheduler,
} from "./stored-trust-pass.ts";
import { trustTableWrites } from "./stored-trust-writes.ts";

/** The store's stored-row trust options (ADR 0125). */
export interface StoredTrustOptions {
  /** The stored-event shape fingerprint; tests change it to stand in for a schema change. */
  eventShape?: string;
  /** The identity stored-row trust is kept under (`storedTrustBuild`); none keeps nothing. */
  storedTrustBuild?: string | undefined;
  /**
   * A second connection of the daemon's own build, such as the history publication worker:
   * it reads the daemon's trust record, never writes one, and runs no idle pass.
   */
  storedTrustReader?: boolean;
  /** Ticks of the idle pass that confirms older rows (`stored-trust-pass.ts`), for tests. */
  trustPass?: { scheduler: TrustPassScheduler; rejectedLimit?: number; batchesPerSave?: number };
}

/**
 * Set the store's `trust` at open (`stored-shape.ts`). Returns what the idle pass extends, or
 * undefined for a reader, which runs none.
 */
export function openStoreTrust(
  db: DatabaseSync,
  shape: string,
  options: StoredTrustOptions,
  trust: StoredTrust,
): OpenedTrust | undefined {
  if (!options.storedTrustReader)
    return openStoredTrust(db, shape, options.storedTrustBuild, trust);
  readStoredTrust(db, shape, options.storedTrustBuild, trust);
  return undefined;
}

export interface StoreTrustPassInput {
  db: DatabaseSync;
  shape: string;
  opened: OpenedTrust | undefined;
  trust: StoredTrust;
  options: StoredTrustOptions;
  /** Live work the store knows of: a transaction, a history write, held writes, buffered output. */
  busy(): boolean;
  headSeq(): number;
  /** Count rows the trust writes changed as accounted for, belonging to no thread. */
  accounted(rows: number): void;
  report(error: unknown): void;
}

/** Start the idle trust pass for a store that opened trust as its owner; nothing for a reader. */
export function startStoreTrustPass(input: StoreTrustPassInput): { close(): void } {
  const { db, opened, options } = input;
  if (!opened) return { close: () => {} };
  return startStoredTrustPass({
    scheduler: options.trustPass?.scheduler ?? scheduleTrustPass,
    rejectedLimit: options.trustPass?.rejectedLimit,
    batchesPerSave: options.trustPass?.batchesPerSave,
    db,
    writes: trustTableWrites({ db, accounted: input.accounted }),
    shape: input.shape,
    opened,
    trust: input.trust,
    busy: () => db.isTransaction || input.busy() || runInProgress(db),
    headSeq: input.headSeq,
    report: input.report,
  });
}
