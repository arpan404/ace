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
 * A child's generation advances whenever its parent sends it new work, so a status reply
 * read before that work can't settle it afterwards.
 */
export const machineChildGenerations = `${machineChildren}
  ALTER TABLE machine_children ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;`;
