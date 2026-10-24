/**
 * What transfers need from Git and from the folder archive owner (ADR 0099). `@ace/git` and
 * `@ace/files` implement these; the transfer owners only see the shapes.
 */
export interface TransferGit {
  transferOrigin(path: string): Promise<{ url: string; normalized: string } | undefined>;
  bundleRefs(path: string): Promise<{
    branches: string[];
    tags: string[];
    originTracking: string[];
    branch?: string | undefined;
    head?: string | undefined;
  }>;
  captureChanges(
    path: string,
    input: { ref: string; message?: string },
  ): Promise<{ commit: string; head: string } | undefined>;
  createBundle(
    path: string,
    input: { file: string; refs: string[]; exclude?: string[] },
  ): Promise<{ bytes: number } | { empty: true }>;
  deleteRef(path: string, ref: string): Promise<void>;
  cloneFromBundle(input: {
    parent: string;
    path: string;
    bundle: string;
    branch?: string;
  }): Promise<void>;
  verifyBundle(path: string, bundle: string): Promise<boolean>;
  fetchBundle(path: string, bundle: string, refspecs: string[]): Promise<void>;
  applyChanges(path: string, commit: string): Promise<void>;
  landingBranch(
    path: string,
    input: { branch: string; commit: string; machine: string },
  ): Promise<{ branch: string; existing: boolean }>;
  createBranch(path: string, name: string, commit: string): Promise<void>;
  checkoutBranch(path: string, input: { name: string; commit: string }): Promise<void>;
  checkoutState(path: string): Promise<{ clean: boolean; branch?: string; head?: string }>;
  fastForward(path: string, commit: string): Promise<void>;
  addBranchWorktree(repo: string, input: { path: string; branch: string }): Promise<void>;
}

export interface TransferArchive {
  measureFolder(root: string, options?: { signal?: AbortSignal }): Promise<{ bytes: number }>;
  packFolder(
    root: string,
    file: string,
    options?: { signal?: AbortSignal; maxBytes?: number },
  ): Promise<{ bytes: number; sha256: string }>;
  unpackArchive(
    file: string,
    destination: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ entries: number }>;
}

/** A transfer stopped, in words a person acts on. */
export class TransferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message.slice(0, 512));
    this.code = code.slice(0, 64);
  }
}
