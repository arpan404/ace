import { can } from "@ace/ui-core";
import { useRepositoryCapabilities } from "@/lib/repository-capabilities.ts";
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgeIssueDetail, ForgeRepository } from "@ace/protocol";
import { ForgeCompletions, ForgeContentScope, issueParticipants } from "@/features/forge/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { backLabel, useBackToList } from "./back-to-list.ts";
import { IssueAbout } from "./issue-about.tsx";
import { IssueActionsStrip } from "./issue-actions-strip.tsx";
import { IssueDescription } from "./issue-description.tsx";
import { IssueHeader } from "./issue-header.tsx";
import { IssueComposer } from "./issue-composer.tsx";
import { IssueTimeline, timelineSpeakers } from "./issue-timeline.tsx";
import { IssuePageSkeleton } from "./issue-skeletons.tsx";
import { useIssueWrites } from "./issue-writes.ts";
import { cachedRow, useIssueDetail } from "./lists.ts";
import { useProjectName } from "@/lib/projects.ts";
import { IssuePages, PullRequestPages } from "@/components/forge-links.tsx";
import { repositoryFromParam } from "@/lib/pull-request-route.ts";

/** A page's reading width, as a pull request's page has. */
export const readable = "mx-auto w-full max-w-[64rem] px-4 sm:px-8";

function IssueBody(props: {
  project: string;
  /** The issue's repository when it isn't the project's own. */
  repository: ForgeRepository | undefined;
  issue: ForgeIssueDetail;
  backLabel: string;
  onBack(): void;
}) {
  const source = useRepositoryCapabilities(props.project, props.issue.ref.repository);
  const issue = can(
    props.issue.capabilities !== undefined
      ? { repository: props.issue.ref.repository, capabilities: props.issue.capabilities }
      : source,
    "issues.write",
  )
    ? props.issue
    : {
        ...props.issue,
        permissions: {
          ...props.issue.permissions,
          edit: false,
          triage: false,
          comment: false,
          close: false,
          reopen: false,
        },
      };
  const writes = useIssueWrites(props.project, issue.ref.repository, {
    repository: issue.ref.repository,
    capabilities: issue.capabilities,
  });
  // Read when a search runs: everyone who has spoken on the pages read so far, latest first.
  const cache = useQueryClient();
  const { project, repository } = props;
  const participants = useCallback(
    () => issueParticipants(issue, timelineSpeakers(cache, project, repository, issue.ref.number)),
    [cache, project, repository, issue],
  );
  const issueRepository = issue.ref.repository;
  const scope = useMemo(
    () => ({
      workspaceId: props.project,
      repository: issueRepository,
      capabilities: issue.capabilities,
    }),
    [props.project, issueRepository, issue.capabilities],
  );
  return (
    <ForgeContentScope value={scope}>
      <ForgeCompletions
        workspaceId={props.project}
        repository={issue.ref.repository}
        participants={participants}
      >
        <div className={`${readable} pt-6 pb-16`}>
          <IssueHeader
            project={props.project}
            issue={issue}
            writes={writes}
            backLabel={props.backLabel}
            onBack={props.onBack}
          />
          <IssueActionsStrip project={props.project} issue={issue} writes={writes} />
          <IssueAbout project={props.project} issue={issue} writes={writes} />
          <IssueDescription issue={issue} writes={writes} />
          <IssueTimeline
            project={props.project}
            repository={props.repository}
            number={issue.ref.number}
            comments={issue.commentCount}
          />
          <IssueComposer project={props.project} issue={issue} writes={writes} />
        </div>
      </ForgeCompletions>
    </ForgeContentScope>
  );
}

/**
 * One issue as a page in the main column: its description, conversation and the actions GitHub
 * allows, at a readable width. Back (or Escape) returns to the list as it was.
 */
export function IssuePage(props: {
  project: string;
  number: number;
  /** A repository other than the project's own (`github.com/acme/ace`). */
  repo?: string | undefined;
  /** The list's own address, when opened from it. */
  back: string | undefined;
}) {
  const choice = { name: useProjectName() };
  const back = useBackToList("/issues", props.back);
  const label = backLabel(props.back, "Issues");
  const repository = repositoryFromParam(props.repo);
  const query = useIssueDetail(props.project, props.number, repository);
  const cache = useQueryClient();
  const issue = query.data;
  return (
    <Screen title={`#${props.number}`} crumb={choice.name(props.project)}>
      <PullRequestPages project={props.project}>
        <IssuePages project={props.project}>
          <article aria-label={`Issue #${props.number}`} className="h-full overflow-y-auto">
            {issue ? (
              <IssueBody
                project={props.project}
                repository={repository}
                issue={issue}
                backLabel={label}
                onBack={back}
              />
            ) : query.isError ? (
              <EmptyState
                title={`Couldn't open issue #${props.number}`}
                description={query.error.message}
                action={
                  <Button size="sm" onClick={() => void query.refetch()}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <IssuePageSkeleton
                number={props.number}
                seed={cachedRow(cache, props.project, "issueList", props.number, repository)}
                backLabel={label}
                onBack={back}
                readable={readable}
              />
            )}
          </article>
        </IssuePages>
      </PullRequestPages>
    </Screen>
  );
}
