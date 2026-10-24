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
/** Queued after a deliberate stop began and before `before`: no device could have taken it. */
export interface SleepWindow {
  after: number;
  before: number;
}
const slept = (id: string, window: SleepWindow | undefined) => {
  const at = queuedAt(id);
  return window !== undefined && at > window.after && at < window.before;
};

/** An agent's notify call writes a notice item with its intent; no other event names one. */
export const isNotice = (event: Event) =>
  event.payload.type === "item.created" && event.payload.item.type === "notice";

/**
 * Hands one page of queued agent notices to the worker, then runs delivery. Notices queued in
 * the sleep window are let go unsent; any others, however old, are delivered. Returns whether
 * a full page was read, so more may wait.
 */
export async function deliverIntents(
  store: IntentStore,
  worker: Pick<NotificationWorker, "notify" | "drain">,
  window: SleepWindow | undefined,
): Promise<boolean> {
  const entries = store.readMcpIntents(64, "mcp.notify");
  for (const entry of entries) {
    if (entry.intent.type !== "mcp.notify") continue;
    const thread = store.getThread(entry.intent.threadId);
    if (thread && !slept(entry.id, window))
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

/** While the worker is stopped no device can take a notice, so ones in the window go. */
export async function dropIntents(store: IntentStore, window: SleepWindow): Promise<void> {
  for (const entry of store.readMcpIntents(64, "mcp.notify"))
    if (slept(entry.id, window)) {
      await store.writable();
      store.acknowledgeMcpIntent(entry.id);
    }
}
