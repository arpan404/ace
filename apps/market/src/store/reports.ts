import type {
  MarketReportRequest,
  MarketReportsBody,
  ReportResolution,
} from "@ace/protocol/marketplace";
import type { z } from "zod";
import type { Databases } from "./databases.ts";

/*
 * Anonymous abuse reports (ADR 0173 §7), in the moderation database: the entry, the reason and
 * the words, and nothing about who sent them. An entry holds at most 500 open ones, counted in
 * the statement that files one.
 */

export const openReportsPerEntry = 500;

export type Filed = "filed" | "missing" | "full";

export async function fileReport(
  dbs: Pick<Databases, "catalogue" | "moderation">,
  report: MarketReportRequest,
  id: string,
  now: number,
): Promise<Filed> {
  const catalogue = dbs.catalogue(report.type);
  const entry = catalogue
    ? await catalogue
        .prepare("SELECT 1 AS found FROM entries WHERE type = ?1 AND name = ?2")
        .bind(report.type, report.name)
        .first()
    : null;
  if (!entry) return "missing";
  const result = await dbs.moderation
    .prepare(
      `INSERT INTO reports (id, type, name, version, reason, note, at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
        WHERE (SELECT COUNT(*) FROM reports WHERE type = ?2 AND name = ?3 AND state = 'open') < ?8`,
    )
    .bind(
      id,
      report.type,
      report.name,
      report.version ?? null,
      report.reason,
      report.note,
      now,
      openReportsPerEntry,
    )
    .run();
  return result.meta.changes === 1 ? "filed" : "full";
}

type Row = MarketReportsBody["reports"][number];

/** Open reports first, then newest first. */
export async function listReports(db: D1Database): Promise<Row[]> {
  const { results } = await db
    .prepare(
      `SELECT id, type, name, version, reason, note, at, state, outcome FROM reports
        ORDER BY state = 'open' DESC, at DESC LIMIT 500`,
    )
    .all<{
      id: string;
      type: Row["type"];
      name: string;
      version: string | null;
      reason: Row["reason"];
      note: string;
      at: number;
      state: Row["state"];
      outcome: string | null;
    }>();
  return results.map((row) => {
    const report: Row = {
      id: row.id,
      type: row.type,
      name: row.name,
      reason: row.reason,
      note: row.note,
      at: row.at,
      state: row.state,
    };
    if (row.version) report.version = row.version;
    if (row.outcome) report.outcome = row.outcome;
    return report;
  });
}

export async function resolveReport(
  db: D1Database,
  id: string,
  resolution: z.infer<typeof ReportResolution>,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE reports SET state = ?2, outcome = ?3, resolved = ?4 WHERE id = ?1")
    .bind(id, resolution.state, resolution.note ?? null, now)
    .run();
  return result.meta.changes === 1;
}
