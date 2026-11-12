/**
 * What the sidebar lists, orders and counts a thread by, as SQL over its threads row. These are
 * the definitions: `sidebar-columns.ts` keeps their values per thread, and a database holding a
 * row they can't read (malformed JSON) is listed by evaluating them directly.
 */

/**
 * Counted in project totals: not an unsent draft, nor a thread a paired machine's agent delegated
 * here (it belongs under its parent there). Matches projection's sidebarPage counts.
 */
export const sidebarCounted =
  "COALESCE(json_extract(client, '$.hasSentMessage'), 1) != 0 AND NOT (json_extract(client, '$.hasSentMessage') IS NULL AND json_extract(status, '$.state') = 'new' AND title = 'New thread') AND json_extract(transitions, '$.delegatedFrom') IS NULL";
// Queue attention and settled membership exactly match projection.sidebarSettled.
const attention =
  "COALESCE(json_extract(provider_metadata, '$.queue.paused'), 0) = 1 AND json_extract(provider_metadata, '$.queue.resumeAt') IS NULL AND json_extract(provider_metadata, '$.queue.reason') IS NOT NULL AND json_extract(provider_metadata, '$.queue.reason') NOT IN ('limit', 'snooze') AND NOT (json_extract(provider_metadata, '$.queue.reason') = 'manual' AND COALESCE(json_extract(provider_metadata, '$.queue.pendingCount'), 0) = 0)";
/** Paged with the history below the live threads; may be NULL, which is neither. */
export const sidebarSettled = `COALESCE(json_extract(client, '$.pinned'), 0) != 1 AND json_extract(client, '$.settledAt') IS NOT NULL AND json_extract(status, '$.state') NOT IN ('working', 'needs_you') AND (COALESCE(json_extract(client, '$.settledReason'), '') = 'manual' OR NOT (${attention}))`;
/** Gone from every list: deleted, or a host thread the daemon holds for itself (ADR 0121). */
export const sidebarDeleted =
  "(json_extract(client, '$.deletedAt') IS NOT NULL OR json_extract(client, '$.host') IS NOT NULL)";
export const sidebarActivity = "COALESCE(json_extract(client, '$.activityAt'), updated_at)";

/**
 * Whether the expressions above can be evaluated on this row: every JSON column they read is
 * NULL or JSON text. json_extract raises on anything else, so such a row fails the read.
 */
export const sidebarReadable =
  "(json_valid(client) IS NOT 0 AND json_valid(status) IS NOT 0 AND json_valid(provider_metadata) IS NOT 0 AND json_valid(transitions) IS NOT 0 AND typeof(client) != 'blob' AND typeof(status) != 'blob' AND typeof(provider_metadata) != 'blob' AND typeof(transitions) != 'blob')";

/**
 * One thread's facts from its threads row, named as `sidebar_thread_columns` holds them. Read
 * from `threads`, or a subquery shaped like it.
 */
export const sidebarFactColumns = `workspace_id AS workspace_id, (${sidebarDeleted}) AS deleted, archived_at IS NOT NULL AS archived, (${sidebarSettled}) AS settled, CASE WHEN (${sidebarCounted}) THEN 1 ELSE 0 END AS counted, ${sidebarActivity} AS activity, archived_at AS archived_at`;
