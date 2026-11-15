import type { EntityCollection } from "@ace/protocol";

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
 * sequence) created before `before`, as the daemon pages them: up to 200 entries or `maxBytes`
 * unless one alone is more, newest first. `active-first`, as the daemon does: the newest page
 * carries every active entity first and older pages only inactive ones. `chronological`, as
 * daemons before it did: newest first whatever the state.
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
    entity,
    seq: index + 1,
    bytes: JSON.stringify(entity).length,
  }));
  const isActive = (entity: unknown) => active(collection, entity);
  const most = Math.min(limit, 200);
  const newestPage = before >= Number.MAX_SAFE_INTEGER;
  const activeFirst =
    mode === "active-first" && all.filter(({ entity }) => isActive(entity)).length <= 200;
  const rows =
    activeFirst && newestPage ? all.filter(({ entity }) => isActive(entity)).toReversed() : [];
  let bytes = rows.reduce((total, row) => total + row.bytes, 0);
  const room = Math.max(0, most - rows.length);
  const rest = all
    .filter(({ entity, seq }) => seq < before && !(activeFirst && isActive(entity)))
    .toReversed();
  let taken = 0;
  let more = false;
  let oldest = before;
  for (const row of rest) {
    if (taken >= room || (rows.length && bytes + row.bytes > maxBytes)) {
      more = true;
      break;
    }
    rows.push(row);
    bytes += row.bytes;
    taken++;
    oldest = row.seq;
  }
  if (activeFirst && newestPage && taken === 0) {
    if (room === 0) more = rest.length > 0;
    oldest = Number.MAX_SAFE_INTEGER - 1;
  }
  return {
    entries: rows.toSorted((a, b) => a.seq - b.seq).map(({ entity }) => entity),
    entitiesBefore: more ? oldest : null,
  };
}
