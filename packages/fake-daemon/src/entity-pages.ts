import type { EntityCollection } from "@ace/protocol";
import { entityPage as pageOf, type TooLarge } from "@ace/projection/entity-pages";

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
 * `entityPage`), entities over `largest` named in `tooLarge`. `chronological`, as daemons before
 * it did: every entity created before `before`, newest first whatever the state, up to 200
 * entries or `maxBytes` unless one alone is more.
 */
export function entityPage(
  inOrder: readonly unknown[],
  collection: EntityCollection,
  before: number,
  limit: number,
  maxBytes: number,
  mode: "active-first" | "chronological",
  largest?: number,
): { entries: unknown[]; tooLarge?: TooLarge[]; entitiesBefore: number | null } {
  const all = inOrder.map((entity, index) => {
    const json = JSON.stringify(entity);
    const record = entity as { id?: unknown; request?: { kind?: unknown } };
    return {
      seq: index + 1,
      id: String(record.id),
      bytes: Buffer.byteLength(json),
      length: json.length,
      entity: () => entity,
      kind: () => (typeof record.request?.kind === "string" ? record.request.kind : undefined),
      active: active(collection, entity),
    };
  });
  if (mode === "active-first") {
    const rows = (isActive: boolean) => (below: number) =>
      all.filter((row) => row.active === isActive && row.seq < below).toReversed();
    const { tooLarge, ...page } = pageOf(
      { active: rows(true), inactive: rows(false) },
      before,
      limit,
      maxBytes,
      largest,
    );
    return tooLarge.length ? { ...page, tooLarge } : page;
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
