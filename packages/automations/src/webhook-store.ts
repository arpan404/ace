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
      "CREATE TABLE IF NOT EXISTS automation_webhooks(automation_id TEXT PRIMARY KEY, hook_id TEXT NOT NULL UNIQUE, secret TEXT NOT NULL)",
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
