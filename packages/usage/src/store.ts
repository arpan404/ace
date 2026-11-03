import { UsageBatch } from "./events.ts";
import { matchModel } from "./litellm.ts";
import { defaultPrices, type PriceTable } from "./settings.ts";
import { SessionTotals } from "./session-totals.ts";
import { DatabaseSync, type StatementSync } from "@ace/provider-kit/sqlite";
import { UsageResult, type UsageResult as Result } from "@ace/protocol";
import { migrate } from "./database.ts";
import { dayFormatter, resolvePrices, UsageSettings } from "./settings.ts";
import { Ingestion } from "./ingestion.ts";
import { queryRows } from "./queries.ts";
import { burnRate, QuotaWindow } from "./quotas.ts";
import { retainedDay } from "./retention.ts";

/** Synchronous SQLite boundary. The daemon uses UsageWorker, not this class. */
export class UsageStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly sessionTotals: SessionTotals;
  private readonly ingestion: Ingestion;
  private readonly settings: UsageSettings;
  private priceVersion: string;
  private priceSources: string[];
  private priceAsOf: string | undefined;
  private readonly day: (at: number) => string;
  private prices: PriceTable;
  private readonly known = new Set<string>();
  constructor(path: string, settings: unknown = {}) {
    this.settings = UsageSettings.parse(settings);
    const prices = resolvePrices(this.settings);
    this.prices = prices;
    this.priceVersion = prices.version;
    this.priceSources = prices.sources;
    this.priceAsOf = prices.asOf;
    this.day = dayFormatter(this.settings.timezone);
    this.db = new DatabaseSync(path);
    try {
      migrate(this.db, this.settings.timezone);
      for (const row of this.db
        .prepare(
          "SELECT model FROM usage_daily GROUP BY model ORDER BY MAX(day), SUM(CAST(input AS REAL)+output)",
        )
        .iterate())
        this.known.add(String(row.model));
      this.updatePrices(this.settings.prices);
      this.sessionTotals = new SessionTotals(this.db);
      this.ingestion = new Ingestion(
        this.db,
        this.day,
        this.settings.retentionDays,
        this.settings.incrementRetentionDays,
      );
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
    const result = this.ingestion.ingest(batch);
    // Parse at the boundary; inspect only this batch, never scan usage history on ingestion.
    const parsed = UsageBatch.parse(batch);
    for (const { payload } of parsed.events) {
      if (payload.type !== "usage.updated") continue;
      let model = payload.model;
      if (!model)
        model = String(
          this.statement("SELECT model FROM usage_agents WHERE agent=?").get(payload.agentId)
            ?.model ?? "",
        );
      if (model) {
        if (!this.known.has(model)) this.insertPrice(model);
        this.known.delete(model);
        this.known.add(model);
      }
    }
    return result;
  }
  private insertPrice(model: string): void {
    const key = matchModel(model, this.prices.models);
    const fallback = matchModel(model, defaultPrices.models);
    const rate =
      key === undefined
        ? fallback === undefined
          ? undefined
          : defaultPrices.models[fallback]
        : this.prices.models[key];
    if (!rate) {
      const historical =
        this.settings.fetchPrices &&
        this.statement("SELECT 1 FROM usage_price_history WHERE model=? LIMIT 1").get(model);
      if (historical) this.insertHistory(model);
      return;
    }
    const values = [
      rate.input,
      rate.cached,
      rate.write,
      rate.write1h,
      rate.output,
      rate.reasoning ?? rate.output,
    ];
    if (!this.settings.fetchPrices || this.settings.priceOverrides[model]) {
      this.statement(
        "INSERT OR REPLACE INTO usage_prices VALUES (?, '0000', '9999', ?, ?, ?, ?, ?, ?)",
      ).run(model, ...values);
      return;
    }
    const previous = this.statement(
      "SELECT input,cached,write,write1h,output,reasoning FROM usage_price_history WHERE model=? ORDER BY day DESC LIMIT 1",
    ).get(model);
    if (
      !previous ||
      values.some(
        (value, index) =>
          value !==
          previous[["input", "cached", "write", "write1h", "output", "reasoning"][index] ?? ""],
      )
    )
      this.statement(
        "INSERT OR REPLACE INTO usage_price_history VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        model,
        rate.asOf ?? (key === undefined ? defaultPrices.asOf : this.prices.asOf) ?? "0000",
        ...values,
      );
    this.insertHistory(model);
  }
  private insertHistory(model: string): void {
    this.statement(`INSERT OR REPLACE INTO usage_prices
      SELECT model, CASE WHEN ROW_NUMBER() OVER (ORDER BY day)=1 THEN '0000' ELSE day END,
      COALESCE(LEAD(day) OVER (ORDER BY day), '9999'), input, cached, write, write1h, output, reasoning
      FROM usage_price_history WHERE model=?`).run(model);
  }

  updatePrices(prices: PriceTable): void {
    this.prices = resolvePrices({ ...this.settings, prices });
    this.priceVersion = this.prices.version;
    this.priceSources = this.prices.sources.map(
      (source) => `${source}#as-of=${this.prices.asOf ?? "unknown"}`,
    );
    this.priceAsOf = this.prices.asOf;
    this.db.exec("BEGIN; DELETE FROM usage_prices;");
    try {
      for (const model of this.known) this.insertPrice(model);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  modelsInUse(): string[] {
    return [...this.known].toReversed().filter(Boolean);
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
      priceSources: this.priceSources,
      priceAsOf: this.priceAsOf,
      costLabel: "estimate",
      tokenSource: "cli",
      retainedFrom: retainedDay(
        this.day(
          Number(this.statement("SELECT latest_at FROM usage_meta WHERE id=1").get()?.latest_at),
        ),
        this.settings.retentionDays,
      ),
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
    const earliest = Math.max(
      0,
      Number(this.statement("SELECT latest_at FROM usage_meta WHERE id=1").get()?.latest_at) -
        this.settings.incrementRetentionDays * 86_400_000,
    );
    const result = burnRate(window, Number(window.unit === "tokens" ? row?.tokens : row?.usd), now);
    if (window.start < earliest) return { ...result, complete: false, exhaustionAt: null };
    return result;
  }
  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
