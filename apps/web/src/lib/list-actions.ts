/*
 * The list actions that decide on the thread list (archive, delete): what organize code holds
 * while one waits to be sent. They carry no command; `sendListAction` in live-actions.ts builds
 * and sends it, checking the list as it does. Kept apart so the sidebar's first paint doesn't
 * load the sender.
 */

/** A list action that decides on the thread list (archive, delete), sent with `sendListAction` (live-actions.ts). */
export interface ListAction {
  readonly listAction: true;
  readonly kind: "archive" | "delete";
  readonly threadId: string;
  /** A delete that stops what still runs (Stop and delete). */
  readonly force?: boolean | undefined;
}
export const archiveAction = (threadId: string): ListAction => ({
  listAction: true,
  kind: "archive",
  threadId,
});
export const deleteAction = (threadId: string, force: boolean): ListAction => ({
  listAction: true,
  kind: "delete",
  threadId,
  force,
});

export const isListAction = (value: object): value is ListAction => "listAction" in value;
