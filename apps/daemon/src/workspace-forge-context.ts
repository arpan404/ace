import type { GitService } from "@ace/git";
import type { ForgeResourceOwner } from "./forge-resource-owner.ts";
import type { ForgeBackends } from "./forge-backends.ts";
import type { SourceControl } from "./source-control.ts";
import type { StackSyncGit } from "./forge-stack-sync.ts";
import type { Store } from "./store.ts";
import type { WorkspacePrLinks } from "./workspace-pr-links.ts";

export type WorkspaceForgeGit = Pick<GitService, "repositoryInfo"> &
  Partial<Pick<GitService, "withWritingGuard" | "pushLeased">> &
  Partial<StackSyncGit>;

/** What the workspace forge's parts share: storage, the PR association owner and backends. */
export interface WorkspaceForgeContext {
  store: Store;
  owner: ForgeResourceOwner;
  now: () => number;
  /** Ends when the workspace forge closes. */
  signal: AbortSignal;
  git: WorkspaceForgeGit;
  sourceControl: SourceControl | undefined;
  backends: ForgeBackends;
  projection: WorkspacePrLinks;
  links: WorkspacePrLinks["links"];
}
