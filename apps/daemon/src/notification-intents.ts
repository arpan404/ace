import type { NotificationWorker } from "@ace/notify";
import type { Event } from "@ace/protocol";
import type { Store } from "./store.ts";
import { uuidV7Time } from "./time-ordered-id.ts";

type IntentStore = Pick<
  Store,
  "readMcpIntents" | "getThread" | "writable" | "acknowledgeMcpIntent"
>;
/** When an intent was queued; its id is a UUIDv7. Unknown ids count as new. */
const queuedAt = (id: string) => uuidV7Time(id) ?? Number.MAX_SAFE_INTEGER;

/** An agent's notify call writes a notice item with its intent; no other event names one. */
export const isNotice = (event: Event) =>
  event.payload.type === "item.created" && event.payload.item.type === "notice";

/**
 * Hands one page of queued agent notices to the worker, then runs delivery. Notices queued
 * before `alertsFrom` are let go unsent. Returns whether a full page was read, so more may wait.
 */
export async function deliverIntents(
  store: IntentStore,
  worker: Pick<NotificationWorker, "notify" | "drain">,
  alertsFrom: number,
): Promise<boolean> {
  const entries = store.readMcpIntents(64, "mcp.notify");
  for (const entry of entries) {
    if (entry.intent.type !== "mcp.notify") continue;
    const thread = store.getThread(entry.intent.threadId);
    if (thread && queuedAt(entry.id) >= alertsFrom)
      await worker.notify({
        id: `mcp:${entry.id}`,
        threadId: thread.id,
        title: thread.title.slice(0, 200),
        status: "agent_says",
        message: entry.intent.notice.text.slice(0, 300),
        backgroundCount: 0,
        actions: [],
      });
    await store.writable();
    store.acknowledgeMcpIntent(entry.id);
  }
  await worker.drain();
  return entries.length === 64;
}

/** While the worker is stopped no device can take a notice, so ones queued before `before` go. */
export async function dropIntents(store: IntentStore, before: number): Promise<void> {
  for (const entry of store.readMcpIntents(64, "mcp.notify"))
    if (queuedAt(entry.id) < before) {
      await store.writable();
      store.acknowledgeMcpIntent(entry.id);
    }
}
