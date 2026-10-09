/** The Add project dialog's tabs. */
export type AddTab = "open" | "create" | "clone";

/** A folder that couldn't be added directly, and why: Add project opens beside it. */
export interface FolderAttempt {
  path: string;
  problem: string;
  canAllow?: boolean | undefined;
}

/** What the project dialogs are asked to do. */
export type ProjectRequest =
  /** Add project, on one of its tabs. */
  | { kind: "add"; tab: AddTab; attempt?: FolderAttempt }
  /**
   * Add a folder known by path (dropped on the window, picked natively): it opens New thread
   * in it, or Add project with the reason when the daemon can't take it.
   */
  | { kind: "folder"; path: string }
  /** A folder dropped on the window: its path is read in the desktop app, else it's picked. */
  | { kind: "dropped"; file: File }
  | { kind: "permissions"; projectId: string }
  | { kind: "edit"; projectId: string }
  | { kind: "remove"; projectId: string };
