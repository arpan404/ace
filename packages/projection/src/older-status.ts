/*
 * Thread statuses as a client that predates the `moved` state (ADR 0191) can read them. Such a
 * client's decoder rejects the whole message for the unknown state and drops its socket, so a
 * connection whose hello doesn't list the `moved-status` trim gets each moved status as
 * `waiting` on `upstream`: the work goes on elsewhere, so the thread is neither working here nor
 * done, and the thread's `continuedOn` already names the machine it went to. Those clients keep
 * it unsettled, as a moved thread is.
 *
 * Statuses ride in many messages (thread lists and snapshots, thread events, delegation items,
 * machine views, search hits), so the walk is structural rather than per message type, and
 * copy-on-write: a message without a moved status is returned as it came, allocating nothing.
 */

/** What an older client reads in place of `{ state: "moved", to }`. */
export const olderMovedStatus = { state: "waiting", on: "upstream" } as const;

/** `message` with every moved thread status read as an older client can, or itself if none. */
export function olderStatuses<T>(message: T): T {
  // Same shape with only the status values replaced: still a `T`.
  return older(message) as T;
}

function older(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const entry: unknown = value[index];
      const next = older(entry);
      if (next === entry) continue;
      copy ??= value.slice();
      copy[index] = next;
    }
    return copy ?? value;
  }
  const record = value as Record<string, unknown>;
  if (isMovedStatus(record)) return { ...olderMovedStatus };
  let changed: Map<string, unknown> | undefined;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    // A search hit names its thread's state as a bare word beside its sequence.
    const next =
      key === "status" && entry === "moved" && typeof record.statusSeq === "number"
        ? olderMovedStatus.state
        : older(entry);
    if (next === entry) continue;
    changed ??= new Map();
    changed.set(key, next);
  }
  if (!changed) return value;
  const changes = changed;
  // Own data properties, so an id such as `__proto__` survives.
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      changes.has(key) ? changes.get(key) : entry,
    ]),
  );
}

/** A `ThreadStatus` of the `moved` state: exactly `state` and its destination. */
function isMovedStatus(record: Record<string, unknown>): boolean {
  if (record.state !== "moved") return false;
  const to = record.to;
  return (
    typeof to === "object" &&
    to !== null &&
    "hostId" in to &&
    "threadId" in to &&
    Object.keys(record).length === 2
  );
}
