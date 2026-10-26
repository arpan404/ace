/*
 * Schema steps for agents working across paired machines (ADR 0078, ADR 0099). Each is one
 * forward migration; the tables they extend were created lazily before, so each step creates
 * them first when this database never used machines.
 */

/** Children this machine delegated to others, created as the caller service has made it. */
const machineChildren = `CREATE TABLE IF NOT EXISTS machine_children (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, parent_thread TEXT NOT NULL,
  parent_agent TEXT NOT NULL, machine TEXT NOT NULL, role TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, view TEXT,
  settled INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0);`;

/** Threads paired devices' agents started here, created as the target service has made it. */
const machineThreads = `CREATE TABLE IF NOT EXISTS machine_threads (
  thread_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL,
  origin_host TEXT NOT NULL, origin_thread TEXT NOT NULL, created_at INTEGER NOT NULL);`;

/**
 * Which calling thread elsewhere each delegated thread here counts against, and whether it holds
 * one of that thread's run slots (`active`). Delegations made before this table existed are
 * filled in from machine_threads, active while their thread is live, so the limit counts them;
 * the target's startup pass then gives back slots of threads held for the person.
 */
export const machineChildLaunches = `${machineThreads}
  CREATE TABLE IF NOT EXISTS machine_child_launches (
    thread_id TEXT PRIMARY KEY, parent TEXT NOT NULL, role TEXT NOT NULL, outcome TEXT,
    active INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS machine_child_launches_active
    ON machine_child_launches(parent, active);
  INSERT OR IGNORE INTO machine_child_launches (thread_id, parent, role, outcome, active)
    SELECT m.thread_id, json_array(m.device_id, m.origin_host, m.origin_thread), '', NULL,
      CASE WHEN json_extract(t.status, '$.state') IN ('new', 'done', 'failed') THEN 0 ELSE 1 END
    FROM machine_threads m JOIN threads t ON t.id = m.thread_id
    WHERE m.kind = 'delegate';`;

/**
 * Keeps a child watched across new work and settles.
 * - `generation` advances whenever its parent sends it new work, so a status reply read before
 *   that work can't settle it afterwards.
 * - `machine_child_messages` holds each message sent to it until its machine has answered for it
 *   (taken or refused); while one is unanswered no status reply settles the child, and the
 *   message is sent again under the same request id, which its machine runs at most once, each
 *   retry after a growing wait (`attempts`, `next_retry_at`) so failing ones step aside.
 * - `settled_at` and `rechecked` let the caller keep re-checking recently settled children that
 *   work started on their machine may reopen, in turns, so every one is eventually checked.
 */
export const machineChildGenerations = `${machineChildren}
  ALTER TABLE machine_children ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE machine_children ADD COLUMN settled_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN rechecked INTEGER NOT NULL DEFAULT 0;
  UPDATE machine_children SET settled_at = created_at WHERE settled = 1;
  CREATE INDEX IF NOT EXISTS machine_children_settled ON machine_children(settled, settled_at);
  CREATE INDEX IF NOT EXISTS machine_children_recheck
    ON machine_children(settled, machine, rechecked);
  CREATE TABLE IF NOT EXISTS machine_child_messages (
    child_id TEXT NOT NULL, request_id TEXT NOT NULL, message TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (child_id, request_id));
  CREATE INDEX IF NOT EXISTS machine_child_messages_due
    ON machine_child_messages(next_retry_at, created_at);`;
