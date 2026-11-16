import type { MarketEntryRef, MarketSignals, MarketTransfer } from "@ace/protocol/marketplace";
import { dayOf } from "../rules.ts";
import { refreshEntry, touchEntries } from "./entries.ts";
import { unpinStatement } from "./profiles.ts";

/*
 * Transfers between publishers, appeals and a publisher's own signals (ADR 0173 §5). Signals are
 * anonymous totals from `downloads_daily`, which the download counting writes; this only reads.
 */

export const transferDays = 7;

interface TransferTable {
  id: string;
  type: MarketTransfer["type"];
  name: string;
  from_publisher: string;
  to_publisher: string;
  at: number;
  expires: number;
  from_name: string;
  to_name: string;
}

const transferColumns = `t.*, f.name AS from_name, r.name AS to_name FROM transfers t
  JOIN publishers f ON f.id = t.from_publisher JOIN publishers r ON r.id = t.to_publisher`;

const transferOf = (row: TransferTable, self: string): MarketTransfer => ({
  id: row.id,
  type: row.type,
  name: row.name,
  from: row.from_name,
  to: row.to_name,
  at: row.at,
  expiresAt: row.expires,
  direction: row.to_publisher === self ? "incoming" : "outgoing",
});

/** The publisher's offers, both ways, that haven't expired. */
export async function transfersOf(
  db: D1Database,
  publisher: string,
  now: number,
): Promise<MarketTransfer[]> {
  const { results } = await db
    .prepare(
      `SELECT ${transferColumns} WHERE (t.from_publisher = ?1 OR t.to_publisher = ?1)
        AND t.expires > ?2 ORDER BY t.at LIMIT 100`,
    )
    .bind(publisher, now)
    .all<TransferTable>();
  return results.map((row) => transferOf(row, publisher));
}

export async function transferById(db: D1Database, id: string) {
  return (
    (await db
      .prepare(`SELECT ${transferColumns} WHERE t.id = ?1`)
      .bind(id)
      .first<TransferTable>()) ?? undefined
  );
}

/** Offers the entry; an earlier offer of it is replaced. */
export async function offerTransfer(
  db: D1Database,
  input: { id: string; entry: MarketEntryRef; from: string; to: string; now: number },
): Promise<MarketTransfer | undefined> {
  await db
    .prepare(
      `INSERT INTO transfers (id, type, name, from_publisher, to_publisher, at, expires)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT (type, name) DO UPDATE SET id = excluded.id,
          from_publisher = excluded.from_publisher, to_publisher = excluded.to_publisher,
          at = excluded.at, expires = excluded.expires`,
    )
    .bind(
      input.id,
      input.entry.type,
      input.entry.name,
      input.from,
      input.to,
      input.now,
      input.now + transferDays * 86_400_000,
    )
    .run();
  const row = await transferById(db, input.id);
  return row ? transferOf(row, input.from) : undefined;
}

/**
 * Moves the entry to the offer's receiver, if the giver still owns it and the offer stands:
 * unpinned from the giver, its index row restamped. Signed manifests stay as they were.
 */
export async function acceptTransfer(
  db: D1Database,
  transfer: {
    id: string;
    type: string;
    name: string;
    from_publisher: string;
    to_publisher: string;
  },
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE entries SET publisher = ?3, generation = generation + 1
          WHERE type = ?1 AND name = ?2 AND publisher = ?4
          AND EXISTS (SELECT 1 FROM transfers WHERE id = ?5 AND expires > ?6)`,
      )
      .bind(
        transfer.type,
        transfer.name,
        transfer.to_publisher,
        transfer.from_publisher,
        transfer.id,
        now,
      ),
    unpinStatement(db, transfer.from_publisher, transfer as MarketEntryRef),
    db.prepare("DELETE FROM transfers WHERE id = ?1").bind(transfer.id),
  ]);
  const moved = (results[0]?.meta.changes ?? 0) === 1;
  if (moved) {
    // The new owner's standing may differ; its handle is new to the index either way.
    await refreshEntry(db, transfer.type, transfer.name, now);
    await touchEntries(db, [transfer], now);
  }
  return moved;
}

export async function deleteTransfer(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM transfers WHERE id = ?1").bind(id).run();
}

/** An appeal on a blocked or held version; one open appeal per version. */
export async function addAppeal(
  db: D1Database,
  input: {
    id: string;
    type: string;
    name: string;
    version: string;
    publisher: string;
    note: string;
    replacement: string | undefined;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO appeals (id, type, name, version, publisher, note, replacement, at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE NOT EXISTS (
          SELECT 1 FROM appeals WHERE type = ?2 AND name = ?3 AND version = ?4 AND state = 'open')`,
    )
    .bind(
      input.id,
      input.type,
      input.name,
      input.version,
      input.publisher,
      input.note,
      input.replacement ?? null,
      input.now,
    )
    .run();
  return result.meta.changes === 1;
}

/** Download totals per version per day for 90 days, adoption over 30, and reports received. */
export async function signals(
  db: D1Database,
  key: MarketEntryRef,
  latest: string | undefined,
  versions: readonly string[],
  now: number,
): Promise<MarketSignals> {
  const today = dayOf(now);
  const first = today - 89;
  const [daily, reports] = await Promise.all([
    db
      .prepare(
        `SELECT version, day, count FROM downloads_daily
          WHERE type = ?1 AND name = ?2 AND day >= ?3 AND day <= ?4`,
      )
      .bind(key.type, key.name, first, today)
      .all<{ version: string; day: number; count: number }>(),
    db
      .prepare(
        "SELECT reason, state, at FROM reports WHERE type = ?1 AND name = ?2 ORDER BY at DESC LIMIT 500",
      )
      .bind(key.type, key.name)
      .all<MarketSignals["reports"][number]>(),
  ]);
  const days = Array.from({ length: 90 }, (_, index) => first + index);
  const counts = new Map<string, number[]>(versions.map((version) => [version, days.map(() => 0)]));
  for (const row of daily.results) {
    const list = counts.get(row.version) ?? days.map(() => 0);
    list[row.day - first] = (list[row.day - first] ?? 0) + row.count;
    counts.set(row.version, list);
  }
  let recent = 0;
  let onLatest = 0;
  for (const [version, list] of counts) {
    const sum = list.slice(-30).reduce((total, count) => total + count, 0);
    recent += sum;
    if (version === latest) onLatest += sum;
  }
  return {
    days,
    versions: [...counts].slice(0, 200).map(([version, downloads]) => ({ version, downloads })),
    adoption: {
      ...(latest ? { latest } : {}),
      share: recent === 0 ? 0 : onLatest / recent,
      downloads: recent,
    },
    reports: reports.results.map((row) => ({ reason: row.reason, state: row.state, at: row.at })),
  };
}
