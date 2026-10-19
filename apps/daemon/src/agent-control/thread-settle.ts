import { Command, type AgentControlResult, type ThreadId } from "@ace/protocol";
import { organizeThread } from "../thread-organization.ts";
import type { Store } from "../store.ts";
import { controlCommandId } from "./command-id.ts";

/**
 * An agent's settle is the person's Settle. A thread still working (an agent settling its own
 * thread always is) settles once it is done, so the agent can ask before its turn ends. A
 * thread waiting on the person stays in front of them.
 */
export function settleThread(store: Store, threadId: ThreadId, at: number): AgentControlResult {
  return store.atomic(() => {
    const thread = store.getThread(threadId);
    if (!thread || thread.deletedAt !== undefined) return { ok: false, code: "not_found" };
    const state = thread.status.state;
    if (state === "working" || state === "waiting") {
      store.appendEvents(
        threadId,
        [{ type: "thread.client.updated", changes: { settleWhenDone: true } }],
        at,
      );
      return { ok: true, data: { settled: false, settlesWhenDone: true } };
    }
    if (state !== "done" && state !== "failed" && state !== "new")
      return {
        ok: false,
        code: "not_ready",
        hint:
          state === "needs_you"
            ? "It is waiting on the person; leave it for them to settle."
            : "It is paused; settle it once it is done.",
      };
    const result = organize(store, threadId, "thread.settle", at);
    return result.ok ? { ok: true, data: { settled: true } } : result;
  });
}

/** Brings a settled thread back to the active list and cancels a pending settle. */
export function unsettleThread(store: Store, threadId: ThreadId, at: number): AgentControlResult {
  return store.atomic(() => {
    const result = organize(store, threadId, "thread.unsettle", at);
    return result.ok ? { ok: true, data: { settled: false } } : result;
  });
}

function organize(
  store: Store,
  threadId: ThreadId,
  type: "thread.settle" | "thread.unsettle",
  at: number,
): AgentControlResult {
  // Settling is idempotent, so the id only has to be unique per call, never a receipt.
  const id = controlCommandId(threadId, String(at), type);
  const result = organizeThread(
    store,
    Command.parse({ id, deviceId: "ace-agent", payload: { type, threadId } }),
    at,
  );
  if (result.ok) return { ok: true };
  return { ok: false, code: result.error === "thread_not_found" ? "not_found" : "not_ready" };
}
