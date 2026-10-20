import { runCard, type OffshiftJournal } from "@ace/offshift";
import { runMark } from "@ace/projection";
import { ThreadId, type WorkspaceId } from "@ace/protocol";
import { OffshiftRunCard, type OffshiftRoles } from "@ace/protocol/offshift";
import type { Store } from "../store.ts";

/** At most this many threads have their card republished when a project's roles change. */
export const republishCap = 32;

/**
 * Republishes the latest card of the workspace's threads whose run is unfinished and whose
 * roles in use change under the project's new defaults, so the Summary never shows stale roles.
 * The run is unchanged: evidence states stay as of the card's revision and its version stays.
 * Bounded to the `republishCap` most recently updated unfinished cards. Call inside the
 * transaction that wrote the defaults.
 */
export function republishProjectRoles(
  store: Store,
  journal: OffshiftJournal,
  workspace: WorkspaceId,
  roles: OffshiftRoles,
  at: number,
): void {
  const rows = store
    .statement(
      `SELECT v.thread_id AS thread, v.value AS card FROM view_entities v JOIN threads t ON t.id = v.thread_id
       WHERE v.collection = 'offshift' AND t.workspace_id = ?
         AND NOT (json_extract(v.value, '$.phase') = 'delivery' AND json_extract(v.value, '$.pendingCount') = 0
           AND json_extract(v.value, '$.blocker') IS NULL)
       ORDER BY json_extract(v.value, '$.updatedAt') DESC LIMIT ?`,
    )
    .all(workspace, republishCap);
  for (const row of rows) {
    const threadId = ThreadId.parse(row.thread);
    const card = OffshiftRunCard.parse(JSON.parse(String(row.card)));
    if (runMark(card).state === "delivered") continue;
    const run = journal.run(threadId, card.id);
    if (!run || run.version !== card.version) continue;
    const fresh = runCard(run, card.revision, roles, card.next);
    if (JSON.stringify(fresh.roles) === JSON.stringify(card.roles)) continue;
    store.appendEvents(threadId, [{ type: "offshift.updated", card: fresh }], at);
  }
}
