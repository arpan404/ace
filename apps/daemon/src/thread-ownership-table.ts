/**
 * The table of which machine owns a thread (ADR 0191), shared by its owner
 * (`transfers/live/ownership.ts`) and the engine, which leaves fenced threads out of the work it
 * picks up. New and empty when first made, so creating it at open costs nothing (ADR 0170).
 */
export const threadOwnershipTable = `CREATE TABLE IF NOT EXISTS thread_ownership (
  thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, transfer_id TEXT NOT NULL,
  peer TEXT NOT NULL, epoch INTEGER NOT NULL, prior TEXT, at INTEGER NOT NULL)`;

/** Ownership states in which nothing new runs for the thread on this machine. */
export const fencedOwnership = "'stopping','handing','moved'";

/**
 * The other threads of a moving thread's tree here (its subagents, at any depth): fenced with it,
 * by `root_id`'s ownership record, until the move ends.
 */
export const threadFenceTable = `CREATE TABLE IF NOT EXISTS thread_fence (
  thread_id TEXT PRIMARY KEY, root_id TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS thread_fence_root ON thread_fence(root_id)`;
