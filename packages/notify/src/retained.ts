import { existsSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { FORMAT } from "./format.ts";

export const deliverableJobs =
  "SELECT jobs.due FROM jobs JOIN devices ON devices.id=jobs.device WHERE devices.revoked=0 AND devices.expired=0 ORDER BY jobs.due LIMIT 1";
/**
 * Work that a stopped worker would miss: queued alerts or jobs, a device that can take an alert
 * while no client is connected (push, or a phone's catch-up inbox), or a phone's Live Activity
 * tokens, which its daemon pushes with from startup. Live-socket desktop and web devices alone
 * need nothing until one connects.
 */
export function retainsWork(statement: (sql: string) => Pick<StatementSync, "get">): boolean {
  if (
    statement("SELECT 1 FROM pending LIMIT 1").get() !== undefined ||
    statement(deliverableJobs).get() !== undefined ||
    statement(
      "SELECT 1 FROM devices WHERE revoked=0 AND expired=0 AND NOT (json_extract(body,'$.address.channel')='websocket' AND json_extract(body,'$.address.platform') IN ('desktop','web')) LIMIT 1",
    ).get() !== undefined
  )
    return true;
  // A store from before Live Activities has no table and keeps nothing: it stays sleepy. Any
  // other failure is the store's own, and must still wake the worker that reports it.
  try {
    return statement("SELECT 1 FROM live_activity LIMIT 1").get() !== undefined;
  } catch (error) {
    if (statement("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_activity'").get())
      throw error;
    return false;
  }
}
/**
 * Read-only check, without opening a worker, of whether the store at `path` retains work. A
 * missing store retains none; one this build cannot read, or any failure, counts as retaining
 * so the worker opens it and reports the problem.
 */
export function notificationsRetained(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      return version !== FORMAT || retainsWork((sql) => db.prepare(sql));
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}
