import { UsageQuery, UsageRow, type UsageResult, UsageDimension } from "@ace/protocol";
import { boundedTotals } from "./numeric.ts";
import type { StatementSync, SQLInputValue } from "node:sqlite";

const columns: Record<UsageDimension, string> = {
  day: "d.day",
  thread: "d.thread",
  agent: "d.agent",
  provider: "d.provider",
  account: "NULLIF(d.account,'')",
  model: "NULLIF(d.model,'')",
  workspace: "d.workspace",
  skill: "d.skill",
  automation: "t.automation",
  // Read at query time, so a parent or delegation linked after the usage still applies.
  role: "CASE WHEN t.delegated=1 THEN 'delegated' WHEN a.parent IS NOT NULL THEN 'subagent' ELSE 'main' END",
};
const dimensionNames = new Set<string>(UsageDimension.options);
/**
 * The rollup a query reads, with the joins its dimensions need. Skill rows live in their own
 * table (one row per skill a turn used), carrying every other dimension so filters compose.
 */
function source(used: ReadonlySet<UsageDimension>): string {
  const table = used.has("skill") ? "usage_skill_daily" : "usage_daily";
  const thread = used.has("automation") || used.has("role");
  return `${table} d${thread ? " LEFT JOIN usage_threads t ON t.thread=d.thread" : ""}${
    used.has("role") ? " LEFT JOIN usage_agents a ON a.agent=d.agent" : ""
  }`;
}
// Late cache classification produces signed adjustments. Linear pricing stays additive across groups.
export const estimateSql = `((d.input-d.cached-d.write)*p.input + d.cached*p.cached +
  (d.write-d.write1h)*p.write + d.write1h*p.write1h + ((d.output-d.reasoning)*p.output+d.reasoning*p.reasoning))/1000000.0`;
const totalsSql = `SUM(CAST(d.input AS REAL)) AS inputTokens, SUM(CAST(d.output AS REAL)) AS outputTokens,
  SUM(CAST(d.cached AS REAL)) AS cachedInputTokens, SUM(CAST(d.reasoning AS REAL)) AS reasoningTokens,
  SUM(CAST(d.write AS REAL)) AS cacheWriteTokens, SUM(CAST(d.write1h AS REAL)) AS cacheWrite1hTokens,
  SUM(d.cost) AS providerReportedUsd,
  SUM(CASE WHEN d.billing='api' THEN COALESCE(${estimateSql},0) ELSE 0 END) AS estimatedUsd,
  SUM(COALESCE(${estimateSql},0)) AS equivalentApiUsd,
  SUM(COALESCE((d.input-d.cached-d.write)*p.input/1000000.0,0)) AS apiInputUsd,
  SUM(COALESCE(d.cached*p.cached/1000000.0,0)) AS apiCacheReadUsd,
  SUM(COALESCE(((d.write-d.write1h)*p.write + d.write1h*p.write1h)/1000000.0,0)) AS apiCacheWriteUsd,
  SUM(COALESCE(((d.output-d.reasoning)*p.output+d.reasoning*p.reasoning)/1000000.0,0)) AS apiOutputUsd,
  SUM(COALESCE(d.cached*(p.input-p.cached)/1000000.0,0)) AS cacheSavingsUsd,
  SUM(CASE WHEN p.model IS NULL THEN CAST(d.input AS REAL)+CAST(d.output AS REAL) ELSE 0 END) AS unpricedTokens,
  SUM(CASE WHEN p.model IS NULL THEN 1 ELSE 0 END) AS missingPrices,
  SUM(CASE WHEN d.billing='subscription' THEN CAST(d.input AS REAL)+CAST(d.output AS REAL) ELSE 0 END) AS subscriptionTokens,
  SUM(CASE WHEN d.billing='unknown' THEN CAST(d.input AS REAL)+CAST(d.output AS REAL) ELSE 0 END) AS unknownBillingTokens`;

export function queryRows(
  prepare: (sql: string) => StatementSync,
  input: unknown,
  kind: "summary" | "series",
): Pick<UsageResult, "rows" | "truncated"> {
  const q = UsageQuery.parse(input);
  const dayColumn =
    q.bucket === "month"
      ? "substr(d.day,1,7)||'-01'"
      : q.bucket === "week"
        ? "date(d.day,'-'||((CAST(strftime('%w',d.day) AS INTEGER)+6)%7)||' days')"
        : columns.day;
  const queryColumns = { ...columns, day: dayColumn };
  const groups =
    kind === "series" ? [...new Set<UsageDimension>(["day", ...q.groupBy])] : q.groupBy;
  const clauses = ["d.day BETWEEN ? AND ?"];
  const params: SQLInputValue[] = [q.from, q.to];
  for (const dim of Object.keys(columns)) {
    const dimension = UsageDimension.parse(dim);
    const values = q.filters[dimension];
    if (values) {
      clauses.push(`${columns[dimension]} IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
  }
  const from = source(
    new Set([...groups, ...UsageDimension.options.filter((d) => q.filters[d] !== undefined)]),
  );
  let cte = "";
  if (q.agentTree) {
    cte = `WITH RECURSIVE subtree(agent) AS (
      SELECT agent FROM usage_agents WHERE agent=?
      UNION SELECT a.agent FROM usage_agents a JOIN subtree s ON a.parent=s.agent
    )`;
    clauses.push("d.agent IN (SELECT agent FROM subtree)");
    params.unshift(q.agentTree);
  }
  const selectGroups = groups.map((g) => `${queryColumns[g]} AS "${g}"`).join(", ");
  const groupSql = groups.length ? `GROUP BY ${groups.map((g) => queryColumns[g]).join(", ")}` : "";
  const order =
    kind === "series"
      ? '"day" ASC'
      : q.orderBy === "tokens"
        ? "inputTokens+outputTokens DESC"
        : "CASE WHEN providerReportedUsd>0 THEN providerReportedUsd ELSE estimatedUsd END DESC";
  const tie = groups.length ? `, ${groups.map((g) => `"${g}"`).join(", ")}` : "";
  // Aggregate counts before evaluating prices. A year has many agent/day rows,
  // but only a few model/billing combinations per requested group.
  const aggregate = `SELECT ${selectGroups ? `${selectGroups}, ` : ""}
    d.model AS pricing_model, d.day AS pricing_day, d.billing,
    SUM(CAST(d.input AS REAL)) AS input, SUM(CAST(d.output AS REAL)) AS output, SUM(CAST(d.cached AS REAL)) AS cached,
    SUM(CAST(d.reasoning AS REAL)) AS reasoning, SUM(CAST(d.write AS REAL)) AS write, SUM(CAST(d.write1h AS REAL)) AS write1h, SUM(d.cost) AS cost
    FROM ${from} WHERE ${clauses.join(" AND ")}
    GROUP BY ${[...groups.map((g) => queryColumns[g]), "d.day", "d.model", "d.billing"].join(", ")}`;
  const sql =
    groups.length === 1 && groups[0] === "day"
      ? `${cte} SELECT ${selectGroups}, ${totalsSql}
        FROM ${from} LEFT JOIN usage_prices p ON p.model=d.model AND d.day>=p.start AND d.day<p.end
        WHERE ${clauses.join(" AND ")} ${groupSql} ORDER BY ${order}${tie} LIMIT ?`
      : `${cte} SELECT ${groups.map((g) => `d."${g}" AS "${g}", `).join("")}${totalsSql}
        FROM (${aggregate}) d LEFT JOIN usage_prices p ON p.model=d.pricing_model AND d.pricing_day>=p.start AND d.pricing_day<p.end
        ${groups.length ? `GROUP BY ${groups.map((g) => `d."${g}"`).join(", ")}` : ""} ORDER BY ${order}${tie} LIMIT ?`;
  const result: UsageRow[] = [];
  let bytes = 2;
  let truncated = false;
  for (const row of prepare(sql).iterate(...params, q.limit + 1)) {
    if (result.length === q.limit) {
      truncated = true;
      break;
    }
    const dimensions: Partial<Record<UsageDimension, unknown>> = {};
    for (const g of groups) dimensions[g] = row[g];
    const totals = Object.entries(row).filter(([key]) => !dimensionNames.has(key));
    const parsed = UsageRow.parse({
      dimensions,
      totals: {
        ...boundedTotals(Object.fromEntries(totals.map(([key, value]) => [key, value ?? 0]))),
        equivalentApiUsd:
          q.equivalentApiCost && !Number(row.missingPrices)
            ? boundedTotals({ equivalentApiUsd: row.equivalentApiUsd ?? 0 }).equivalentApiUsd
            : null,
      },
    });
    const size = Buffer.byteLength(JSON.stringify(parsed)) + 1;
    if (bytes + size > 512 * 1024) {
      truncated = true;
      break;
    }
    result.push(parsed);
    bytes += size;
  }
  return { rows: result, truncated };
}
