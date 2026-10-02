import { z } from "zod";

/** Pre-release engine databases are disposable; no legacy snapshot migration is supported. */
export const engineSchemaVersion = 8;
const databaseVersion = z.object({ version: z.literal(engineSchemaVersion) });
const snapshotVersion = z.object({ engineSnapshot: z.literal(engineSchemaVersion) });
const guidance = `Expected ${engineSchemaVersion}. This unreleased engine does not migrate development snapshots. Start with a fresh development database.`;

export function requireEngineVersion(row: unknown): void {
  if (!databaseVersion.safeParse(row).success)
    throw new Error(`Unsupported engine schema version. ${guidance}`);
}

export function requireSnapshotVersion(value: unknown): void {
  if (!snapshotVersion.safeParse(value).success)
    throw new Error(`Unsupported engine snapshot format. ${guidance}`);
}
