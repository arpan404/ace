import { handoffSources, renderHandoff } from "@ace/handoff";
import type { ExecutionSelection, PortableHandoff, ThreadId } from "@ace/protocol";
import { SessionOpenError } from "@ace/provider-kit/open-error";
import type { EngineRepository } from "./repository.ts";
import type { LeftSession } from "./provider-sessions.ts";
import { handoff } from "./transition-history.ts";

/*
 * What a cross-provider switch hands over (ADR 0051, 2026-10-19 amendment). A provider this
 * thread has not run on gets the conversation-first excerpt. A provider returning to the thread
 * resumes the native session it left, which already holds everything up to then, so it gets only
 * what happened since: nothing at all when nothing did. Should that session be gone when it
 * opens, the full excerpt goes to a fresh session instead.
 */

export interface CrossProviderPlan {
  /** The provider's own earlier session, resumed on its next open. */
  resume?: LeftSession;
  /** What goes in front of the next message; none when the resumed session already knows all. */
  handoff?: PortableHandoff;
  /** The full handoff, for a fresh session if `resume` turns out to be gone. */
  fallback?: PortableHandoff;
}

export function planCrossProvider(
  repo: EngineRepository,
  id: ThreadId,
  args: {
    from: ExecutionSelection;
    to: ExecutionSelection;
    /** The destination can resume a native session at all. */
    resumable: boolean;
    /** The destination's backend: a remembered session is resumed only on the same one. */
    backend: string | undefined;
    budget: number;
  },
): CrossProviderPlan {
  const head = repo.store.headSeq();
  const full = handoff(repo, id, head, args.budget, args.from.provider);
  const left = args.resumable
    ? repo.transitions.left.recall(id, args.to.provider, args.to.instanceId)
    : undefined;
  if (!left || left.backend !== args.backend) return { handoff: full };
  const delta = handoff(repo, id, head, args.budget, args.from.provider, left.throughSeq);
  const happened = delta.excerpts.length > 0 || delta.omittedItems > 0;
  return { resume: left, ...(happened ? { handoff: delta } : {}), fallback: full };
}

/**
 * The resumed session could not be opened because the provider no longer has it: forget it,
 * clear the thread's native session and hand the full context to a fresh one. True when the
 * caller should open again; false for any other failure, which stays the caller's.
 */
export function abandonReturn(
  repo: EngineRepository,
  id: ThreadId,
  error: unknown,
  at: number,
): boolean {
  const metadata = repo.transitions.get(id);
  const failure = error instanceof Error && "cause" in error ? error.cause : error;
  if (
    !metadata.fallback ||
    !(failure instanceof SessionOpenError) ||
    failure.code !== "resume_unavailable"
  )
    return false;
  const full = metadata.fallback;
  const provider = repo.requireState(id).config.provider;
  repo.store.atomic(() => {
    const session = repo.session(id);
    if (session.nativeSessionId)
      repo.transitions.left.forget(id, provider, session.nativeSessionId);
    repo.store
      .statement("UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?")
      .run(id);
    const marker = metadata.marker ?? `handoff:fallback:${full.throughSeq}`;
    const shown = repo.requireState(id).items[marker];
    const selection = metadata.selection;
    repo.syntheticInput(
      id,
      marker,
      renderHandoff(full),
      {
        ...(shown?.type === "message" && shown.origin ? shown.origin : { kind: "handoff" }),
        ...(selection ? { to: { provider: selection.provider, model: selection.model } } : {}),
        sources:
          full.sources ?? handoffSources([], { provider: full.origin?.provider ?? provider }),
        lossy: true,
        threadIds: [full.sourceThreadId],
      },
      at,
    );
    const { fallback: _used, ...rest } = metadata;
    repo.transitions.set(id, { ...rest, handoff: full, marker });
  });
  return true;
}
