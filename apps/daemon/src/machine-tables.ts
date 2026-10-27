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

/**
 * Keeps every remote child within reach (ADR 0099).
 * - `device_id` names the paired device a child was delegated through, so the caller knows when
 *   that pairing is gone (removed, or the machine linked again as a new device). Children from
 *   before have none and fall back to the machine's name.
 * - Indexes for a parent's children (listing, cascading Stop) and for settled results not yet
 *   delivered, so neither reads the whole history or stops at a fixed count.
 * - `lost_at`, `lost_key` and `lost_ask` mark a child whose pairing is gone: it stays unsettled,
 *   and its parent asks the person (the open approval's key and id) until the pairing returns or
 *   the person stops tracking it.
 * - `machine_child_cursors` schedules polling: one row per machine with unsettled children, the
 *   poll turn it was last served in and the id it read up to, so a poll serves the machines served
 *   longest ago and pages each one from where it stopped, wrapping. A partial index keeps those
 *   pages to the machine's unsettled children.
 * - `machine_message_rejections` is the target's answer for a message it refused before it ever
 *   reached its thread (an access or ownership refusal, a deleted thread). It is checked before any
 *   copy of that request is admitted, so a refused request can never run later. Each is kept only
 *   while its device can still be admitted: revoking the device deletes them (the trigger), as a
 *   revoked device never authenticates again, so no copy of its requests can arrive.
 */
export const machineChildReach = `
  ALTER TABLE machine_children ADD COLUMN device_id TEXT;
  ALTER TABLE machine_children ADD COLUMN lost_at INTEGER;
  ALTER TABLE machine_children ADD COLUMN lost_key TEXT;
  ALTER TABLE machine_children ADD COLUMN lost_ask TEXT;
  CREATE INDEX IF NOT EXISTS machine_children_lost ON machine_children(lost_ask)
    WHERE lost_ask IS NOT NULL;
  CREATE INDEX IF NOT EXISTS machine_children_parent ON machine_children(parent_thread, settled);
  CREATE INDEX IF NOT EXISTS machine_children_undelivered ON machine_children(settled_at)
    WHERE settled = 1 AND delivered = 0;
  CREATE TABLE IF NOT EXISTS machine_child_cursors (
    machine TEXT PRIMARY KEY, served INTEGER NOT NULL DEFAULT 0, after TEXT);
  CREATE INDEX IF NOT EXISTS machine_child_cursors_served
    ON machine_child_cursors(served, machine);
  CREATE INDEX IF NOT EXISTS machine_children_unsettled ON machine_children(machine, id)
    WHERE settled = 0;
  INSERT OR IGNORE INTO machine_child_cursors (machine)
    SELECT DISTINCT machine FROM machine_children WHERE settled = 0;
  CREATE TABLE IF NOT EXISTS machine_message_rejections (
    request_key TEXT PRIMARY KEY, device_id TEXT NOT NULL, code TEXT NOT NULL,
    message TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS machine_message_rejections_device
    ON machine_message_rejections(device_id);
  CREATE TRIGGER IF NOT EXISTS machine_message_rejections_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_message_rejections WHERE device_id = NEW.id; END;`;

/**
 * What each linked machine's agents may do here, per capability (ADR 0105). Sparse: a missing
 * row is the capability's default, so existing pairings keep what `remote.agentAccess` gave.
 * A revoked pairing takes its grants with it, so nothing paired later inherits them.
 */
export const machineGrants = `CREATE TABLE IF NOT EXISTS machine_grants (
  device_id TEXT NOT NULL, capability TEXT NOT NULL, level TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, capability));
  CREATE TRIGGER IF NOT EXISTS machine_grants_revoked
    AFTER UPDATE OF revoked_at ON devices WHEN NEW.revoked_at IS NOT NULL
    BEGIN DELETE FROM machine_grants WHERE device_id = NEW.id; END;`;
