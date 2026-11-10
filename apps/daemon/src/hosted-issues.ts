import type { z } from "zod";
import type { ForgeIssueEvent } from "@ace/protocol/forge-issues";
import { ForgeError, GitLabIssues, gitlabIssueWrites, repositoryWriteRefusal, type GitHubForge } from "@ace/forge";
import type { ForgeRepository } from "@ace/protocol";
import type { SourceControl } from "./source-control.ts";
import type { ForgeBackends } from "./forge-backends.ts";

/** The common issue contract keeps the durable action journal host independent. */
export type HostedIssues = Pick<GitHubForge, "listIssues" | "issueDetail" | "writeIssue" | "reconcileIssue"> & {
  issueTimeline(number: number, page: number, signal: AbortSignal): Promise<{
    events: z.infer<typeof ForgeIssueEvent>[]; nextPage?: number; lastPage?: number; truncated: boolean;
  }>;
};

export async function hostedIssues(options: {
  cwd: string; repository: ForgeRepository; backends: ForgeBackends;
  sourceControl: SourceControl | undefined; signal: AbortSignal;
}): Promise<HostedIssues> {
  const { cwd, repository, backends, sourceControl, signal } = options;
  if (repository.forge === "github") return backends.backend(cwd, repository);
  if (repository.forge !== "gitlab" || !sourceControl) throw new ForgeError("unsupported");
  const identity = await sourceControl.readIdentity(cwd, repository, signal);
  return new GitLabIssues({ repository, runner: identity.runner });
}

export async function hostedIssueWriter(options: Parameters<typeof hostedIssues>[0]): Promise<HostedIssues> {
  const { cwd, repository, backends, sourceControl, signal } = options;
  const refusal = repositoryWriteRefusal((await backends.projectRepositories(cwd)).resolved, repository);
  if (refusal) throw new Error(refusal);
  if (repository.forge === "github") return backends.writer(cwd, repository);
  if (repository.forge !== "gitlab" || !sourceControl) throw new ForgeError("unsupported");
  const identity = await sourceControl.writeIdentity(cwd, repository, gitlabIssueWrites, signal);
  return new GitLabIssues({ repository, runner: identity.runner });
}
