import type { GitTransfer } from "@ace/git";
import type { measureFolder, packFolder, unpackArchive } from "@ace/files";

/**
 * What transfers need from Git and from the folder archive owner (ADR 0099): `@ace/git`'s
 * transfer primitives and `@ace/files`' folder archives, narrowed so tests see the shapes.
 */
export type TransferGit = Pick<
  GitTransfer,
  | "transferOrigin"
  | "bundleRefs"
  | "captureChanges"
  | "createBundle"
  | "deleteRef"
  | "cloneFromBundle"
  | "verifyBundle"
  | "fetchBundle"
  | "applyChanges"
  | "landingBranch"
  | "createBranch"
  | "checkoutBranch"
  | "checkoutState"
  | "fastForward"
  | "addBranchWorktree"
>;

export interface TransferArchive {
  measureFolder: typeof measureFolder;
  packFolder: typeof packFolder;
  unpackArchive: typeof unpackArchive;
}

/** A transfer stopped, in words a person acts on. */
export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message.slice(0, 512));
    this.code = code.slice(0, 64);
  }
}
