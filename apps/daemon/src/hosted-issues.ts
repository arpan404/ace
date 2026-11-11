import type { z } from "zod";
import { ForgeError, GitLabIssues, gitlabIssueWrites, isTeaHost } from "@ace/forge";
import type {
  ForgeBrowserOperation,
  ForgeBrowserResult,
  ForgeIssueDetail,
  ForgeIssueList,
  ForgeIssueRef,
  ForgeIssueSearch,
  ForgeIssueWrite,
  ForgeRepository,
} from "@ace/protocol";
import type { ForgeIssueEvent } from "@ace/protocol/forge-issues";
import type { ForgeBackends } from "./forge-backends.ts";
import type { IssueActions } from "./issue-actions.ts";
import type { SourceControl } from "./source-control.ts";
import type { WorkspaceIssueLinks } from "./workspace-issue-links.ts";

/** What the durable issue-action journal needs from a host: one write, and its recovery read. */
export interface IssueWrites {
  writeIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
    dispatch?: Parameters<GitLabIssues["writeIssue"]>[3],
  ): Promise<ForgeIssueRef>;
  reconcileIssue(
    input: ForgeIssueWrite,
    actionId: string,
    signal: AbortSignal,
  ): Promise<ForgeIssueRef | null>;
}
/** Issues as every host with them answers: gh, glab or tea. */
export interface HostedIssues extends IssueWrites {
  listIssues(query: ForgeIssueSearch, signal: AbortSignal): Promise<ForgeIssueList>;
  issueDetail(number: number, signal: AbortSignal): Promise<ForgeIssueDetail>;
  issueTimeline(
    number: number,
    page: number,
    signal: AbortSignal,
  ): Promise<{
    events: z.infer<typeof ForgeIssueEvent>[];
    nextPage?: number;
    lastPage?: number;
    truncated: boolean;
  }>;
}

export type IssueScope = {
  cwd: string;
  repository: ForgeRepository;
  backends: ForgeBackends;
  sourceControl: SourceControl | undefined;
  signal: AbortSignal;
};

/** Issue reads, and recovery reads of earlier writes, through the host's read-only identity. */
export async function hostedIssues(scope: IssueScope): Promise<HostedIssues> {
  const { cwd, repository, backends, sourceControl, signal } = scope;
  if (repository.forge === "github") return backends.backend(cwd, repository);
  if (isTeaHost(repository.forge)) return backends.teaIssues(cwd, repository, signal);
  if (repository.forge !== "gitlab" || !sourceControl) throw new ForgeError("unsupported");
  const identity = await sourceControl.readIdentity(cwd, repository, signal);
  return new GitLabIssues({ repository, runner: identity.runner });
}

/**
 * Issue writes, refused first for a hidden or unavailable repository (ADR 0116). Each host's
 * runner admits reads plus exactly its adapter's issue writes (`gitlabIssueWrites`,
 * `teaIssueWrites`), proving the account around each (ADR 0117).
 */
export async function hostedIssueWriter(scope: IssueScope): Promise<IssueWrites> {
  const { cwd, repository, backends, signal } = scope;
  if (repository.forge === "github") return backends.writer(cwd, repository);
  await backends.assertWritable(cwd, repository);
  if (isTeaHost(repository.forge)) return backends.teaIssueWriter(cwd, repository, signal);
  if (repository.forge !== "gitlab") throw new ForgeError("unsupported");
  const identity = await backends.admittedWriter(
    cwd,
    repository,
    gitlabIssueWrites(repository),
    signal,
  );
  return new GitLabIssues({ repository, runner: identity.runner });
}

type IssueRead = Extract<ForgeBrowserOperation, { op: `forge.issue.${string}` }>;

/** Whether a browse operation is an issue read, which `hostedIssueRead` answers for any host. */
export function isIssueRead(operation: ForgeBrowserOperation): operation is IssueRead {
  return operation.op.startsWith("forge.issue.");
}

/** An issue read routed to the repository's host. */
export async function hostedIssueRead(
  operation: IssueRead,
  scope: IssueScope,
  parts: { issueActions: IssueActions; issueLinks: WorkspaceIssueLinks },
): Promise<ForgeBrowserResult> {
  // The action journal is ace's own: no host read.
  if (operation.op === "forge.issue.actions")
    return {
      resource: "issueActions",
      actions: parts.issueActions.list(scope.repository, operation.number),
    };
  const issues = await hostedIssues(scope);
  if (operation.op === "forge.issue.list")
    return { resource: "issueList", value: await issues.listIssues(operation.query, scope.signal) };
  if (operation.op === "forge.issue.timeline")
    return {
      resource: "issueTimeline",
      ...(await issues.issueTimeline(operation.number, operation.page, scope.signal)),
    };
  const value = await issues.issueDetail(operation.number, scope.signal);
  return { resource: "issueDetail", value: { ...value, ...parts.issueLinks.related(value.ref) } };
}
