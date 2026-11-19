import type { EventPayload, ProviderKind, Thread, ThreadId } from "@ace/protocol";

/** A done thread keeps its provider process warm this long before releasing it. */
export const defaultProviderIdleMs = 5 * 60_000;

/**
 * Settling or archiving a thread asks for its warm provider to go now. Unsettling or
 * unarchiving withdraws that request. Other events say nothing about release.
 */
export function releaseRequest(event: EventPayload): "release" | "withdraw" | undefined {
  if (event.type === "thread.updated" && event.archivedAt !== undefined)
    return event.archivedAt === null ? "withdraw" : "release";
  if (event.type === "thread.client.updated" && event.changes.settledAt !== undefined)
    return event.changes.settledAt === null ? "withdraw" : "release";
  return undefined;
}

export function releasedThread(thread: Thread | undefined): boolean {
  return thread?.archivedAt !== undefined || thread?.settledAt !== undefined;
}

/** busy: the thread tree still has live work. idle-warm: done, waiting out the idle window. */
export type ProviderProcessState = "busy" | "idle-warm" | "releasing";
export interface ProviderProcess {
  threadId: ThreadId;
  provider: ProviderKind;
  state: ProviderProcessState;
  /** When the thread became done with this process still warm. */
  idleSince?: number;
  /** When the idle window releases it, unless new work arrives first. */
  releaseAt?: number;
}

export function providerProcessState(input: {
  session: boolean;
  closing: boolean;
  idleSince: number | undefined;
  idleDue: boolean;
}): ProviderProcessState | undefined {
  if (input.closing || (input.session && input.idleDue)) return "releasing";
  if (!input.session) return undefined;
  return input.idleSince === undefined ? "busy" : "idle-warm";
}

/** Every provider process the engine's actors hold, with how far along its release is. */
export function listProviderProcesses(
  actors: Iterable<{
    id: ThreadId;
    session?: unknown;
    idleSince?: number | undefined;
    idleDue: boolean;
    releaseAt(): number | undefined;
  }>,
  closing: (id: ThreadId) => boolean,
  provider: (id: ThreadId) => ProviderKind | undefined,
): ProviderProcess[] {
  const processes: ProviderProcess[] = [];
  for (const actor of actors) {
    const state = providerProcessState({
      session: Boolean(actor.session),
      closing: closing(actor.id),
      idleSince: actor.idleSince,
      idleDue: actor.idleDue,
    });
    const kind = provider(actor.id);
    if (!state || !kind) continue;
    const releaseAt = actor.releaseAt();
    processes.push({
      threadId: actor.id,
      provider: kind,
      state,
      ...(actor.idleSince === undefined ? {} : { idleSince: actor.idleSince }),
      ...(state === "idle-warm" && releaseAt !== undefined ? { releaseAt } : {}),
    });
  }
  return processes;
}
