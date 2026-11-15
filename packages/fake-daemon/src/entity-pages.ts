import type { EntityCollection } from "@ace/protocol";
import { entityPage as pageOf } from "@ace/projection/entity-pages";

/** Whether an entity is active, as the daemon's entity window counts it. */
function active(collection: EntityCollection, entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const value = entity as Record<string, unknown>;
  const status = value.status as Record<string, unknown> | undefined;
  switch (collection) {
    case "agents":
      return (
        value.origin === "root" ||
        ["starting", "working", "blocked", "unresponsive"].includes(String(status?.state))
      );
    case "runs":
      return value.state === "active";
    case "interactions":
      return value.state === "pending";
    case "backgroundTasks":
      return ["running", "unknown"].includes(String(value.status));
  }
}

/**
 * A page of a collection's entities (in creation order; an entity's place is its creation
 * sequence) from `before`. `active-first`, as the daemon pages them (`@ace/projection`'s
 * `entityPage`). `chronological`, as daemons before it did: newest first whatever the state, up
 * to 200 entries or `maxBytes` unless one alone is more, each whole.
 */
export function entityPage(
  inOrder: readonly unknown[],
  collection: EntityCollection,
  before: number,
  limit: number,
  maxBytes: number,
  mode: "active-first" | "chronological",
): { entries: unknown[]; entitiesBefore: number | null } {
  const all = inOrder.map((entity, index) => ({
    seq: index + 1,
    bytes: Buffer.byteLength(JSON.stringify(entity)),
    entity: () => entity,
    active: active(collection, entity),
  }));
  if (mode === "active-first") {
    const rows = (isActive: boolean) => (below: number) =>
      all.filter((row) => row.active === isActive && row.seq < below).toReversed();
    return pageOf({ active: rows(true), inactive: rows(false) }, before, limit, maxBytes);
  }
  const most = Math.min(limit, 200);
  const rows: typeof all = [];
  let bytes = 0;
  for (const row of all.filter(({ seq }) => seq < before).toReversed()) {
    if (rows.length >= most || (rows.length && bytes + row.bytes > maxBytes))
      return {
        entries: rows.toReversed().map(({ entity }) => entity()),
        entitiesBefore: rows.at(-1)?.seq ?? null,
      };
    rows.push(row);
    bytes += row.bytes;
  }
  return { entries: rows.toReversed().map(({ entity }) => entity()), entitiesBefore: null };
}
