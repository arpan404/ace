import type { DatabaseSync, StatementSync } from "@ace/provider-kit/sqlite";

/**
 * Each webhook automation's hook id and secret (ADR 0158, decisions 2 and 5), in their own table
 * of `automations.sqlite`, never inside a definition's JSON, so nothing that reads definitions,
 * lists or runs can carry a secret out.
 */
export class WebhookKeys {
  private readonly sql: (sql: string) => StatementSync;
  constructor(db: DatabaseSync, sql: (sql: string) => StatementSync) {
    this.sql = sql;
    db.exec(
      `CREATE TABLE IF NOT EXISTS automation_webhooks(automation_id TEXT PRIMARY KEY, hook_id TEXT NOT NULL UNIQUE, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_webhook_deliveries(automation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, run_id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(automation_id, delivery_id));
      CREATE INDEX IF NOT EXISTS automation_webhook_expiry ON automation_webhook_deliveries(expires);`,
    );
  }
  /** Sets the automation's secret, keeping its hook id if it has one. Returns the hook id. */
  rotate(automationId: string, newHookId: string, secret: string): string {
    this.sql(
      "INSERT INTO automation_webhooks VALUES(?,?,?) ON CONFLICT(automation_id) DO UPDATE SET secret=excluded.secret",
    ).run(automationId, newHookId, secret);
    return this.hookOf(automationId) ?? newHookId;
  }
  forget(automationId: string): void {
    this.sql("DELETE FROM automation_webhooks WHERE automation_id=?").run(automationId);
    this.sql("DELETE FROM automation_webhook_deliveries WHERE automation_id=?").run(automationId);
  }
  /**
   * The run a delivery started, kept apart from run history, which is pruned to its latest
   * runs: a replay must find its run for as long as its timestamp could still be accepted.
   */
  delivered(automationId: string, deliveryId: string): string | undefined {
    const row = this.sql(
      "SELECT run_id FROM automation_webhook_deliveries WHERE automation_id=? AND delivery_id=?",
    ).get(automationId, deliveryId);
    return row ? String(row.run_id) : undefined;
  }
  /** Notes a delivery's run until `expires`, and drops receipts that have expired by `now`. */
  deliver(
    automationId: string,
    deliveryId: string,
    runId: string,
    expires: number,
    now: number,
  ): void {
    this.sql("DELETE FROM automation_webhook_deliveries WHERE expires < ?").run(now);
    this.sql("INSERT OR IGNORE INTO automation_webhook_deliveries VALUES(?,?,?,?)").run(
      automationId,
      deliveryId,
      runId,
      expires,
    );
  }
  hookOf(automationId: string): string | undefined {
    const row = this.sql("SELECT hook_id FROM automation_webhooks WHERE automation_id=?").get(
      automationId,
    );
    return row ? String(row.hook_id) : undefined;
  }
  byHook(hookId: string): { automationId: string; secret: string } | undefined {
    const row = this.sql(
      "SELECT automation_id, secret FROM automation_webhooks WHERE hook_id=?",
    ).get(hookId);
    return row
      ? { automationId: String(row.automation_id), secret: String(row.secret) }
      : undefined;
  }
}
