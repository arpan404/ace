import { handoffSources, renderHandoff } from "@ace/handoff";
import type { ThreadId } from "@ace/protocol";
import { SessionOpenError, sessionStoreUnusable } from "@ace/provider-kit/open-error";
import type { EngineRepository } from "./repository.ts";
import { maxStoreGeneration } from "./store-generations.ts";
import { handoff } from "./transition-history.ts";

/*
 * A thread whose saved provider session can never be opened again (Cursor's checkpoint grew past
 * its budget, its journal is fenced, its history can't be verified) continues in a fresh session
 * of the same provider, carrying the thread's context from ace's own transcript (ADR 0211).
 *
 * Everything changes in one transaction: the thread moves to its next store generation, forgets
 * its native session and the old session's provider frames, and gets a waiting handoff with its
 * transcript marker. The queued message is untouched: it stays in the queue until the fresh
 * session takes it, and the handoff goes in front of it once, as a switch's does. A crash before
 * the commit leaves the thread as it was, so the next try hands off again; a crash after it opens
 * the fresh generation, never the old one, and never hands off twice.
 */

/**
 * What a fresh session is handed, rendered: about 8k tokens, as a provider switch carries. The
 * opening ask, the latest exchange and recent work; older items stay one handoff_read away.
 */
export const freshSessionHandoffBytes = 32768;

/** Said to the agent after the handoff, so it knows it is resuming its own conversation. */
export function freshSessionNote(provider: string): string {
  return (
    `ace note: this thread's saved ${provider} session could not be opened again, so this is a ` +
    `fresh ${provider} session. The context handoff above is this same conversation, quoted from ` +
    "ace's transcript. Pick it up where it left off; the person's next message follows."
  );
}

/** True when `error`, or the failure it wraps, says the saved session can never open again. */
export function storeUnusable(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    if (current instanceof SessionOpenError && current.code === sessionStoreUnusable) return true;
    if ("code" in current && current.code === sessionStoreUnusable) return true;
    current = current.cause;
  }
  return false;
}

const providerName = (provider: string) => (provider === "cursor" ? "Cursor" : provider);

/**
 * Hands the thread to a fresh session when `error` says its saved one is unusable. True when the
 * caller should open again; false for any other failure, which stays the caller's. A thread with
 * no saved session to leave (a fresh open that failed) is not handed off again.
 */
export function startFreshSession(
  repo: EngineRepository,
  id: ThreadId,
  error: unknown,
  at: number,
  /** The command whose input this handoff goes in front of: quoted once, as the prompt. */
  pendingCommandId?: string,
): boolean {
  if (!storeUnusable(error)) return false;
  const session = repo.session(id);
  if (session.nativeSessionId === undefined) return false;
  if (repo.transitions.generations.get(id) >= maxStoreGeneration) return false;
  const state = repo.requireState(id);
  const provider = state.config.provider;
  const metadata = repo.transitions.get(id);
  const model = metadata.selection?.model ?? session.model;
  repo.store.atomic(() => {
    const generation = repo.transitions.generations.advance(id);
    repo.store
      .statement("UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?")
      .run(id);
    // The old session's frames and boundary cursor are its own; the fresh one starts at zero.
    repo.recovery.reset(id);
    const pending = pendingCommandId ? state.items[`input:${pendingCommandId}`]?.id : undefined;
    const full = handoff(
      repo,
      id,
      repo.store.headSeq(),
      freshSessionHandoffBytes,
      provider,
      undefined,
      pending ? new Set([pending]) : undefined,
    );
    // A handoff still waiting for delivery is replaced, not stacked.
    if (metadata.marker) repo.removeInputItem(id, metadata.marker, at);
    const marker = `handoff:fresh:${generation}`;
    const side = { provider, ...(model ? { model } : {}) };
    repo.syntheticInput(
      id,
      marker,
      renderHandoff(full),
      {
        kind: "handoff",
        from: side,
        sources: full.sources ?? handoffSources([], side),
        lossy: true,
        freshSession: true,
        threadIds: [id],
      },
      at,
    );
    const { fallback: _gone, ...rest } = metadata;
    const note = freshSessionNote(providerName(provider));
    repo.transitions.set(id, {
      ...rest,
      handoff: full,
      marker,
      // Merge summaries already waiting keep their place; the note joins them when there is room.
      context: rest.context.length < 8 ? [...rest.context, note] : rest.context,
    });
  });
  return true;
}
