/**
 * This machine's code (ADR 0111) as a slow hash with a version that grows on every change, the
 * per-machine wrong-attempt lock, and which account devices passed which version.
 */
export const machineCodeTables = `
  CREATE TABLE IF NOT EXISTS machine_code (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    hash TEXT,
    version INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER
  );
  CREATE TABLE IF NOT EXISTS machine_code_passes (
    device_id TEXT NOT NULL,
    account TEXT NOT NULL,
    version INTEGER NOT NULL,
    passed_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, account)
  );`;
