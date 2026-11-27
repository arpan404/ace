/**
 * Stands in for `node:sqlite` in test runs with `ACE_STORE=native` (vitest.config.ts), so a
 * test that opens a database directly uses the same SQLite library as the store under test:
 * two copies of SQLite in one process release each other's file locks (ADR 0222).
 */
export { DatabaseSync } from "./sqlite.ts";
export { NativeStatementSync as StatementSync } from "./native-sqlite.ts";
export { constants } from "node:sqlite";
export { backup } from "./sqlite-backup.ts";
