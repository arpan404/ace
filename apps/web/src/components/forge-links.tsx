import { useThreadMeta } from "@ace/client-react";
import type { ForgeIssueRef, ForgePrRef } from "@ace/protocol";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { pullRequestTab, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { IssueOpener, PullRequestOpener } from "./web-link.tsx";
import { useScopedMachine } from "@/lib/machines.ts";

/*
 * Where links to GitHub pull requests and issues open on a screen: ace's own PR and issue views.
 * Each needs a project to read through; a screen without one leaves links on GitHub.
 */

/** Issue links open ace's page for the issue, read through `project`. */
export function IssuePages(props: { project: string | undefined; children: ReactNode }) {
  const navigate = useNavigate();
  const { project } = props;
  const open = project
    ? (issue: ForgeIssueRef) =>
        void navigate({
          to: "/issues/$project/$number",
          params: { project, number: String(issue.number) },
          search: { repo: repositoryParam(issue.repository) },
        })
    : undefined;
  return <IssueOpener value={open}>{props.children}</IssueOpener>;
}

/** Pull request links open ace's page for the PR, read through `project`. */
export function PullRequestPages(props: { project: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { project } = props;
  const open = (pr: ForgePrRef) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(pr.number) },
      search: { repo: repositoryParam(pr.repository) },
    });
  return <PullRequestOpener value={open}>{props.children}</PullRequestOpener>;
}

/**
 * A thread's links: a pull request opens in the thread's side panel, beside the conversation; an
 * issue opens its page. The issue pages read this window's own machine, so on another machine's
 * thread (ADR 0100) issue links stay on GitHub; the side panel runs on the thread's machine.
 */
export function ThreadForgeLinks(props: { threadId: string; children: ReactNode }) {
  const workspaceId = useThreadMeta(props.threadId)?.workspaceId;
  const elsewhere = useScopedMachine() !== undefined;
  const actions = useWorkspaceActions(props.threadId);
  const open = workspaceId
    ? (pr: ForgePrRef) =>
        actions.open(pullRequestTab({ workspaceId, repository: pr.repository, number: pr.number }))
    : undefined;
  return (
    <PullRequestOpener value={open}>
      <IssuePages project={elsewhere ? undefined : workspaceId}>{props.children}</IssuePages>
    </PullRequestOpener>
  );
}
