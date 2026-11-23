import type {
  MarketScanVerdict,
  RegistryAdminEntry,
  RegistryVersion,
} from "@ace/protocol/marketplace";
import { versionStatus } from "../rules.ts";
import { fromCatalogues, type Databases } from "./databases.ts";
import { orgAudience, shownName } from "./registries.ts";
import { storedVersion, type VersionTable } from "./rows.ts";

/*
 * An organization's registry as its admins read it (ADR 0206 amendment 5): every entry with its
 * newest versions, each with its state, its scan's verdict from the version row (never the R2
 * report, so the page costs one query per catalogue), and a withdrawal waiting for the signer.
 */

/** Versions shown per entry, newest first. */
export const versionsShown = 20;

type Row = VersionTable & {
  title: string;
  latest: string | null;
  withdrawal_reason: string | null;
  withdrawal_at: number | null;
};

function versionOf(row: Row): RegistryVersion {
  const status = versionStatus(storedVersion(row));
  const version: RegistryVersion = {
    version: row.version,
    hash: row.hash,
    size: row.size,
    published: row.published,
    status: status.status,
    held: status.held,
  };
  if (status.reason) version.reason = status.reason.slice(0, 500);
  // Rows this Worker wrote (ADR 0125): `verdict` only ever holds a scan verdict.
  if (row.verdict && row.scanned)
    version.scan = { verdict: row.verdict as MarketScanVerdict, scanner: row.scanned };
  if (row.withdrawal_reason !== null && row.withdrawal_at !== null && !row.withdrawn)
    version.withdrawal = { reason: row.withdrawal_reason.slice(0, 500), at: row.withdrawal_at };
  return version;
}

/** Every entry of `org`'s registry with its newest versions, over every catalogue. */
export async function registryVersions(dbs: Databases, org: string): Promise<RegistryAdminEntry[]> {
  return fromCatalogues(dbs, async ({ type, db }) => {
    const { results } = await db
      .prepare(
        `SELECT * FROM (
            SELECT v.*, e.title AS title, e.latest AS latest,
              w.reason AS withdrawal_reason, w.at AS withdrawal_at,
              ROW_NUMBER() OVER (PARTITION BY v.name ORDER BY v.published DESC, v.version DESC) AS n
            FROM entries e JOIN versions v ON v.type = e.type AND v.name = e.name
            LEFT JOIN pending_withdrawals w
              ON w.type = v.type AND w.name = v.name AND w.version = v.version
            WHERE e.audience = ?1 AND e.archived = 0)
          WHERE n <= ${versionsShown} ORDER BY name, n LIMIT 100000`,
      )
      .bind(orgAudience(org))
      .all<Row>();
    const entries = new Map<string, RegistryAdminEntry>();
    for (const row of results) {
      let entry = entries.get(row.name);
      if (!entry) {
        const name = shownName(row.name);
        const title = row.title === row.name ? name : row.title;
        entry = { type, name, title: title.slice(0, 120), versions: [] };
        if (row.latest) entry.latest = row.latest;
        entries.set(row.name, entry);
      }
      entry.versions.push(versionOf(row));
    }
    return [...entries.values()];
  });
}
