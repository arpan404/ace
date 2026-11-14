import type { ClientApi } from "@ace/client";

/*
 * The list actions that decide on the thread list (archive, delete): what organize code holds
 * while one waits to be sent. They carry no command; `sendListAction` in live-actions.ts builds
 * and sends it, checking the list as it does. Kept apart so the sidebar's first paint doesn't
 * load the sender.
 */

/**
 * What the person was looking at when they decided: the newest thread event this client had
 * seen (its loaded copy's cursor, or its list entry's latest status). Taken when a confirmation
 * opens and carried to the send unchanged, so a dialog answered after newer work started is
 * refused by the daemon (`thread_changed`) instead of being stamped with what came later.
 */
export interface Decided {
  readonly beforeSeq: number | undefined;
}

/** The decision as of now: call when the person is shown the question, not when it is sent. */
export function decide(client: ClientApi, threadId: string): Decided {
  const seen = Math.max(
    client.peekThread?.(threadId)?.cursor ?? -1,
    client.cachedThreads?.()?.thread(threadId)?.activitySeq ?? -1,
  );
  return { beforeSeq: seen < 0 ? undefined : seen };
}

/** A list action that decides on the thread list, sent with `sendListAction` (live-actions.ts). */
export interface ListAction {
  readonly listAction: true;
  readonly kind: "archive" | "delete";
  readonly threadId: string;
  /** A delete that stops what still runs (Stop and delete). */
  readonly force?: boolean | undefined;
  /** What the person decided on; sent exactly as taken. */
  readonly decided: Decided;
}
export const archiveAction = (threadId: string, decided: Decided): ListAction => ({
  listAction: true,
  kind: "archive",
  threadId,
  decided,
});
export const deleteAction = (threadId: string, force: boolean, decided: Decided): ListAction => ({
  listAction: true,
  kind: "delete",
  threadId,
  force,
  decided,
});

export const isListAction = (value: object): value is ListAction => "listAction" in value;
