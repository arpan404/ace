/**
 * Thread organization (ADR 0057): the daemon commands behind settle, snooze, pin, read,
 * rename, move, archive and delete, shown at once and undone on a refusal (`overlay.ts`), with
 * their toasts and Undo, this device's list view state (with the threads picked for a bulk
 * action), the one menu of thread actions both Home and the thread screen show, and the
 * project picker a move asks with.
 */
export {
  useHomeSelection,
  useHomeSelectionState,
  useSelected,
  type BulkConfirm,
  type HomeSelection,
} from "./selection.ts";
export { MoveToProjectHost } from "./move-host.tsx";
export { useThreadMover } from "./mover.ts";
export { SnoozeItems } from "./snooze-items.tsx";
export { ThreadActionItems } from "./thread-action-items.tsx";
export { useOrganizer, useOrganizerState } from "./use-organizer.ts";
export { useOrganizeOverlay, useOverlaidEntry, useRefusedTitle } from "./overlay.ts";
export { useThreadActions, type ThreadActions, type ThreadTarget } from "./use-thread-actions.ts";
