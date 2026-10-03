import { SessionTotals } from "./session-totals.ts";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { UsageResult, type UsageResult as Result } from "@ace/protocol";
import { migrate } from "./database.ts";
import { dayFormatter, resolvePrices, UsageSettings } from "./settings.ts";
import { Ingestion } from "./ingestion.ts";
import { queryRows } from "./queries.ts";
import { burnRate, QuotaWindow } from "./quotas.ts";

/** Synchronous SQLite boundary. The daemon uses UsageWorker, not this class. */
export class UsageStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly sessionTotals: SessionTotals;
  private readonly ingestion: Ingestion;
  private readonly settings: UsageSettings;
  private readonly priceVersion: string;
  constructor(path: string, settings: unknown = {}) {
    this.settings = UsageSettings.parse(settings);
    const prices = resolvePrices(this.settings);
    this.priceVersion = prices.version;
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db, this.settings.timezone);
      const insert = this.db.prepare("INSERT INTO usage_prices VALUES (?, ?, ?, ?, ?, ?)");
      for (const [model, rate] of Object.entries(prices.models))
        insert.run(model, rate.input, rate.cached, rate.write, rate.write1h, rate.output);
      this.sessionTotals = new SessionTotals(this.db);
      this.ingestion = new Ingestion(this.db, dayFormatter(this.settings.timezone));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= 32) {
        const oldest = this.statements.keys().next().value;
        if (oldest !== undefined) this.statements.delete(oldest);
      }
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  cursor(): number {
    return Number(this.statement("SELECT cursor FROM usage_meta WHERE id=1").get()?.cursor);
  }
  ingest(batch: unknown): number {
    return this.ingestion.ingest(batch);
  }
  sessionTotalsFor(input: unknown) {
    return this.sessionTotals.list(input);
  }
  summary(query: unknown): Result {
    return this.query(query, "summary");
  }
  series(query: unknown): Result {
    return this.query(query, "series");
  }
  private query(query: unknown, kind: "summary" | "series"): Result {
    return UsageResult.parse({
      cursor: this.cursor(),
      omittedEvents: Number(
        this.statement("SELECT omitted FROM usage_meta WHERE id=1").get()?.omitted,
      ),
      timezone: this.settings.timezone,
      priceVersion: this.priceVersion,
      ...queryRows((sql) => this.statement(sql), query, kind),
    });
  }
  burn(account: string, input: unknown, now: number) {
    const window = QuotaWindow.parse(input);
    if (!Number.isFinite(now) || now < 0) throw new Error("Invalid clock");
    const row =
      this.statement(`SELECT COALESCE(SUM(CAST(d.input AS REAL)+CAST(d.output AS REAL)),0) AS tokens,
      COALESCE(SUM(d.cost),0) AS usd FROM usage_increments d
      WHERE d.account=? AND d.at>=? AND d.at<?`).get(
        account,
        window.start,
        Math.min(now, window.end),
      );
    return burnRate(window, Number(window.unit === "tokens" ? row?.tokens : row?.usd), now);
  }
  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
