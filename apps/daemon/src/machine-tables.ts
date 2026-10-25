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

/**
 * A child's generation advances whenever its parent sends it new work, so a status reply
 * read before that work can't settle it afterwards.
 */
export const machineChildGenerations = `${machineChildren}
  ALTER TABLE machine_children ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;`;
