import type { StatementSync } from "node:sqlite";

/*
 * The fence on commands that stop a thread's work when they are delivered (a forced delete, an
 * archive): refused (`thread_changed`) once anything that could be work the person didn't see
 * happened, in the thread or any thread it would stop, after the event they decided at. The rule
 * names what is known NOT to matter; every other event, including a type this build doesn't know,
 * counts as a change.
 */

/**
 * Events that never start or add work: what the person organized, read state, and the progress
 * of work that already existed when they decided (its output, its updates, its end). Stopping
 * that work is what they confirmed; refusing on its every token would make a running thread
 * impossible to stop and delete.
 */
const inertTypes = new Set([
  "item.delta",
  "item.updated",
  "item.deleted",
  "run.ended",
  "run.client.updated",
  "agent.status",
  "agent.updated",
  "interaction.closed",
  "background_task.updated",
]);
/** `thread.updated` fields that describe the thread without changing what runs in it. */
const inertThreadFields = new Set([
  "type",
  "title",
  "titleSource",
  "archivedAt",
  "status",
  "permission",
  "capabilities",
  "effectiveCapabilities",
  "acpSupport",
  "goal",
]);
/** `thread.client.updated` fields: organization, read state and the list's projections. */
const inertClientFields = new Set([
  "pinned",
  "pinOrder",
  "listOrder",
  "unread",
  "readAt",
  "settledAt",
  "settledReason",
  "snoozedUntil",
  "snoozeWake",
  "snoozeWoke",
  "deletedAt",
  "activityAt",
  "autoSettleAt",
  "autoSettle",
  "settleWhenDone",
  "prSettled",
  "prSettledKey",
  "activitySeq",
  "hasSentMessage",
  "details",
  "live",
  "movedFrom",
  "host",
  "hostKey",
]);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : {};

/**
 * Whether one stored event may be work the person didn't see. Everything not known inert is:
 * a run starting, input admitted or queued (`queue.updated`), a request raised, a task or agent
 * starting, a person's message, a switch, and any type this build doesn't know. Pure.
 */
export function changesWork(type: string, payload: unknown): boolean {
  if (inertTypes.has(type)) return false;
  const fields = record(payload);
  if (type === "thread.updated")
    return Object.keys(fields).some((key) => !inertThreadFields.has(key));
  if (type === "thread.client.updated")
    return Object.keys(record(fields["changes"])).some((key) => !inertClientFields.has(key));
  // The work's own output inside a run that already ran; only a person's message is new input.
  if (type === "item.created") {
    const item = record(fields["item"]);
    return item["type"] === "message" && item["role"] === "user" && item["synthetic"] !== true;
  }
  return true;
}

/** Past this many events since the decision, the thread surely changed: no need to read more. */
const readLimit = 1_000;

/**
 * Whether any of `threadIds` (a thread and every thread its command would stop) may have work
 * the person didn't see after event `seq`. Event sequences are one order across every thread in
 * the store, so a child's newer run counts like the thread's own. Call inside the transaction
 * that then deletes or archives, so nothing can start between the check and the change.
 */
export function workChangedSince(
  store: { statement(sql: string): StatementSync },
  threadIds: readonly string[],
  seq: number,
): boolean {
  if (threadIds.length === 0) return false;
  const rows = store
    .statement(
      `SELECT type, payload FROM events WHERE seq>? AND thread_id IN (${threadIds
        .map(() => "?")
        .join(",")}) ORDER BY seq LIMIT ${readLimit + 1}`,
    )
    .all(seq, ...threadIds);
  if (rows.length > readLimit) return true;
  return rows.some((row) =>
    changesWork(String(row["type"]), JSON.parse(String(row["payload"])) as unknown),
  );
}
