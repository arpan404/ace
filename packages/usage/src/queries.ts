import { UsageQuery, UsageRow, type UsageResult, UsageDimension } from "@ace/protocol";
import type { StatementSync, SQLInputValue } from "node:sqlite";

const columns: Record<UsageDimension, string> = {
  day: "d.day",
  thread: "d.thread",
  agent: "d.agent",
  provider: "d.provider",
  account: "NULLIF(d.account,'')",
  model: "NULLIF(d.model,'')",
  workspace: "d.workspace",
};
// Reasoning and cache tokens are subsets, never billed twice.
export const estimateSql = `(MAX(0, d.input-d.cached-d.write)*p.input + d.cached*p.cached +
  MAX(0,d.write-d.write1h)*p.write + d.write1h*p.write1h + d.output*p.output)/1000000.0`;
const totalsSql = `SUM(d.input) AS inputTokens, SUM(d.output) AS outputTokens,
  SUM(d.cached) AS cachedInputTokens, SUM(d.reasoning) AS reasoningTokens,
  SUM(d.write) AS cacheWriteTokens, SUM(d.write1h) AS cacheWrite1hTokens,
  SUM(d.cost) AS providerReportedUsd,
  SUM(CASE WHEN d.billing='api' THEN COALESCE(${estimateSql},0) ELSE 0 END) AS estimatedUsd,
  SUM(COALESCE(${estimateSql},0)) AS equivalentApiUsd,
  SUM(CASE WHEN p.model IS NULL THEN d.input+d.output ELSE 0 END) AS unpricedTokens,
  SUM(CASE WHEN d.billing='subscription' THEN d.input+d.output ELSE 0 END) AS subscriptionTokens,
  SUM(CASE WHEN d.billing='unknown' THEN d.input+d.output ELSE 0 END) AS unknownBillingTokens`;

export function queryRows(
  prepare: (sql: string) => StatementSync,
  input: unknown,
  kind: "summary" | "series",
): Pick<UsageResult, "rows" | "truncated"> {
  const q = UsageQuery.parse(input);
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
  let cte = "";
  if (q.agentTree) {
    cte = `WITH RECURSIVE subtree(agent) AS (
      SELECT agent FROM usage_agents WHERE agent=?
      UNION SELECT a.agent FROM usage_agents a JOIN subtree s ON a.parent=s.agent
    )`;
    clauses.push("d.agent IN (SELECT agent FROM subtree)");
    params.unshift(q.agentTree);
  }
  const selectGroups = groups.map((g) => `${columns[g]} AS "${g}"`).join(", ");
  const groupSql = groups.length ? `GROUP BY ${groups.map((g) => columns[g]).join(", ")}` : "";
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
    d.model AS pricing_model, d.billing,
    SUM(d.input) AS input, SUM(d.output) AS output, SUM(d.cached) AS cached,
    SUM(d.reasoning) AS reasoning, SUM(d.write) AS write, SUM(d.write1h) AS write1h, SUM(d.cost) AS cost
    FROM usage_daily d WHERE ${clauses.join(" AND ")}
    GROUP BY ${[...groups.map((g) => columns[g]), "d.model", "d.billing"].join(", ")}`;
  const sql =
    groups.length === 1 && groups[0] === "day"
      ? `${cte} SELECT ${selectGroups}, ${totalsSql}
        FROM usage_daily d LEFT JOIN usage_prices p ON p.model=d.model
        WHERE ${clauses.join(" AND ")} ${groupSql} ORDER BY ${order}${tie} LIMIT ?`
      : `${cte} SELECT ${selectGroups ? `${selectGroups}, ` : ""}${totalsSql}
        FROM (${aggregate}) d LEFT JOIN usage_prices p ON p.model=d.pricing_model
        ${groupSql} ORDER BY ${order}${tie} LIMIT ?`;
  const rows = prepare(sql).all(...params, q.limit + 1);
  const result = rows.slice(0, q.limit).map((row) => {
    const dimensions: Partial<Record<UsageDimension, unknown>> = {};
    for (const g of groups) dimensions[g] = row[g];
    const {
      day: _day,
      thread: _thread,
      agent: _agent,
      provider: _provider,
      account: _account,
      model: _model,
      workspace: _workspace,
      ...totals
    } = row;
    return UsageRow.parse({
      dimensions,
      totals: {
        ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value ?? 0])),
        equivalentApiUsd:
          q.equivalentApiCost && !Number(row.unpricedTokens) ? (row.equivalentApiUsd ?? 0) : null,
      },
    });
  });
  return { rows: result, truncated: rows.length > q.limit };
}
