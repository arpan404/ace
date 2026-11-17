import type { DatabaseSync, StatementSync } from "@ace/provider-kit/sqlite";
import type { SecretBox } from "./webhook-secret-box.ts";

/**
 * Each webhook automation's hook id and secret (ADR 0173, decisions 2 and 5), in their own table
 * of `automations.sqlite`, never inside a definition's JSON, so nothing that reads definitions,
 * lists or runs can carry a secret out. Secrets are sealed with `box` (decision 11); without
 * one, no secret can be made.
 */
export class WebhookKeys {
  private readonly sql: (sql: string) => StatementSync;
  private readonly box: SecretBox | undefined;
  constructor(db: DatabaseSync, sql: (sql: string) => StatementSync, box?: SecretBox) {
    this.sql = sql;
    this.box = box;
    db.exec(
      `CREATE TABLE IF NOT EXISTS automation_webhooks(automation_id TEXT PRIMARY KEY, hook_id TEXT NOT NULL UNIQUE, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_webhook_deliveries(automation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, run_id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(automation_id, delivery_id));
      CREATE INDEX IF NOT EXISTS automation_webhook_expiry ON automation_webhook_deliveries(expires);`,
    );
  }
  /** Sets the automation's secret, keeping its hook id if it has one. Returns the hook id. */
  rotate(automationId: string, newHookId: string, secret: string): string {
    if (!this.box) throw new Error("Webhook secrets need a key on this machine");
    const sealed = this.box.seal(secret, automationId);
    this.sql(
      "INSERT INTO automation_webhooks VALUES(?,?,?) ON CONFLICT(automation_id) DO UPDATE SET secret=excluded.secret",
    ).run(automationId, newHookId, sealed);
    return this.hookOf(automationId) ?? newHookId;
  }
  forget(automationId: string): void {
    this.sql("DELETE FROM automation_webhooks WHERE automation_id=?").run(automationId);
    this.sql("DELETE FROM automation_webhook_deliveries WHERE automation_id=?").run(automationId);
  }
  /**
   * The run a delivery (its event key, `webhook:<id>`) started. Kept apart from run history,
   * which is pruned to each automation's latest runs: a replay must find its run for as long as
   * its timestamp could still be accepted.
   */
  delivered(automationId: string, eventKey: string): string | undefined {
    const row = this.sql(
      "SELECT run_id FROM automation_webhook_deliveries WHERE automation_id=? AND delivery_id=?",
    ).get(automationId, eventKey);
    return row ? String(row.run_id) : undefined;
  }
  /**
   * Notes a delivery's run, in the transaction that admits it, until `expires`; drops receipts
   * that have expired by `now`.
   */
  deliver(automationId: string, eventKey: string, runId: string, expires: number, now: number) {
    this.sql("DELETE FROM automation_webhook_deliveries WHERE expires < ?").run(now);
    this.sql("INSERT OR IGNORE INTO automation_webhook_deliveries VALUES(?,?,?,?)").run(
      automationId,
      eventKey,
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
  /** The hook's automation, and its secret unless it can't be opened with this machine's key. */
  byHook(hookId: string): { automationId: string; secret: string | undefined } | undefined {
    const row = this.sql(
      "SELECT automation_id, secret FROM automation_webhooks WHERE hook_id=?",
    ).get(hookId);
    if (!row) return undefined;
    const automationId = String(row.automation_id);
    return { automationId, secret: this.box?.open(String(row.secret), automationId) };
  }
}
