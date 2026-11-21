import { ThreadId } from "@ace/protocol";
import { ViewOnlyError, type ProductionStartup } from "../runtime/production-startup.ts";

/**
 * Production thread composer wiring: text-only `thread.send` through the
 * reviewed mutation gate.
 *
 * Matches the iOS thread send (`ClientModel.sendMessage` → `thread.send`
 * with words, guarded by `canOperate`) using the existing Android pieces:
 * `ComposerDraft` owns the editing state, `ThreadDraftStore` (keyed by
 * `draftKey(hostId, threadId)`) owns the unsent words, and
 * `startup.runtimeForMutation(hostId)` owns admission. The UI never sees the
 * raw SDK `ClientApi`: the only boundary it touches is this module plus the
 * draft store, and every send resolves a fresh gate at call time, so a grant
 * revoked after the composer mounted still fails closed before touching the
 * wire. `enqueue` itself re-checks the grant and liveness, giving revocation
 * a second check inside the admission.
 *
 * Safe slice: words only, `steer` delivery (the daemon queues where steer is
 * unsupported, matching the fixture "Steer · queues if unavailable" copy).
 * Out of scope: alternate delivery choice, file attachments and mentions,
 * stop-tree, queued-message editing, retry-send and new-thread/project
 * compose. Archived threads never reach the composer here (the production
 * inbox only opens home-window threads) and the caller keeps them read-only.
 */

/** Narrowest startup surface the composer needs: mutation admission only. */
export type ProductionComposerStartup = Pick<ProductionStartup, "runtimeForMutation">;

/** Whether the thread view may offer the composer instead of the read-only note. */
export function canShowProductionComposer(input: {
  canOperate: boolean;
  routePaired: boolean;
  archived?: boolean | undefined;
}): boolean {
  if (input.archived === true) return false;
  return input.canOperate && input.routePaired;
}

/** Text-only `thread.send` payload with `steer` delivery, like the fixture composer. */
export function buildThreadSendPayload(
  threadId: string,
  text: string,
): {
  type: "thread.send";
  threadId: ReturnType<typeof ThreadId.parse>;
  input: { type: "text"; text: string }[];
  delivery: "steer";
} {
  return {
    type: "thread.send",
    threadId: ThreadId.parse(threadId),
    input: [{ type: "text", text }],
    delivery: "steer",
  };
}

/**
 * Admit one follow-up through a freshly resolved gate. The gate is local to
 * this call and discarded after: nothing is cached, so revocation, disconnect
 * or removal between renders still fails here, immediately before the
 * mutation. Whitespace-only text admits nothing and resolves no gate.
 */
export async function sendProductionMessage(
  startup: ProductionComposerStartup,
  hostId: string,
  threadId: string,
  text: string,
): Promise<string> {
  if (text.trim().length === 0) return "empty";
  const gate = startup.runtimeForMutation(hostId);
  return gate.enqueue(buildThreadSendPayload(threadId, text));
}

/** Screen copy for a failed production send. The draft stays put in every case. */
export function productionSendFailureCopy(error: unknown): string {
  if (error instanceof ViewOnlyError) return error.message;
  if (error instanceof Error && /not connected/i.test(error.message)) {
    return "This machine is not connected.";
  }
  return "Message could not be saved. Your draft is still here.";
}

/** Saved copy: durable admission reads "saved" on a live socket, "reconnected" later. */
export function productionSavedCopy(connection: string): string {
  return connection === "ready" ? "Message saved" : "Will send when reconnected";
}
