import {
  ArrowSquareOutIcon,
  ChatsCircleIcon,
  CopyIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ForgeIssueDetail, ForgeRepository } from "@ace/protocol";
import { ForgeContentScope, ForgeProse, useTaskSave } from "@/features/forge/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { RelativeTime as PrTime } from "@/components/person-avatar.tsx";
import { Screen } from "@/features/shell/index.ts";
import { useBackToList } from "./back-to-list.ts";
import { IssueActionsStrip } from "./issue-actions-strip.tsx";
import { IssueComposer } from "./issue-composer.tsx";
import { IssueTimeline } from "./issue-timeline.tsx";
import { IssuePageSkeleton } from "./issue-skeletons.tsx";
import { useIssueWrites } from "./issue-writes.ts";
import { cachedRow, useIssueDetail } from "./lists.ts";
import { LabelPill, StateBadge } from "@/components/forge-marks.tsx";
import { WorkHeading, WorkTitle } from "@/components/work-heading.tsx";
import { Avatars } from "./marks.tsx";
import { useProjectChoice } from "./project-choice.ts";
import { IssuePages, PullRequestPages } from "@/components/forge-links.tsx";
import { repositoryFromParam } from "@/lib/pull-request-route.ts";

/** A page's reading width, as a pull request's page has. */
export const readable = "mx-auto w-full max-w-[64rem] px-4 sm:px-8";

function Header(props: { project: string; issue: ForgeIssueDetail; onBack(): void }) {
  const { issue } = props;
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const navigate = useNavigate();
  const threads = issue.relatedThreads.filter((thread) => !thread.archived);
  return (
    <WorkHeading
      back={{ label: "Issues", onBack: props.onBack }}
      title={<WorkTitle text={issue.title} number={issue.ref.number} />}
      actions={
        <>
          {threads.map((thread) => (
            <Link
              key={thread.id}
              to="/t/$threadId"
              params={{ threadId: thread.id }}
              className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-md px-2 text-ui text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
            >
              <ChatsCircleIcon aria-hidden size={14} className="shrink-0" />
              <span className="truncate">{thread.title}</span>
            </Link>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({ to: "/new", search: { project: props.project, issue: issue.url } })
            }
          >
            New thread
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Issue actions"
                  className="size-6 px-0"
                />
              }
            >
              <DotsThreeIcon aria-hidden size={16} />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                icon={<ArrowSquareOutIcon aria-hidden size={16} />}
                onClick={() =>
                  void openWeb(issue.url).catch(() =>
                    toast.error({ title: "Couldn't open GitHub" }),
                  )
                }
              >
                Open on GitHub
              </MenuItem>
              <MenuItem
                icon={<CopyIcon aria-hidden size={16} />}
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(issue.url)
                    .catch(() => toast.error({ title: "Couldn't copy the link" }))
                }
              >
                Copy link
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
      badge={<StateBadge kind="issue" state={issue.state} />}
      byline={
        <>
          <span className="font-medium text-foreground/85">{issue.author}</span>
          <span>opened</span>
          <PrTime at={issue.createdAt} />
          {issue.labels.map((label) => (
            <LabelPill key={label} name={label} color={issue.labelColors?.[label]} />
          ))}
          {issue.assignees.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <Avatars people={issue.assignees} avatars={issue.avatars} label="Assignees" />
              <span>{issue.assignees.join(", ")}</span>
            </span>
          )}
          {issue.milestone && <span>· {issue.milestone}</span>}
        </>
      }
    />
  );
}

function IssueBody(props: {
  project: string;
  /** The issue's repository when it isn't the project's own. */
  repository: ForgeRepository | undefined;
  issue: ForgeIssueDetail;
  onBack(): void;
}) {
  const { issue } = props;
  const writes = useIssueWrites(props.project, issue.ref.repository);
  const repository = issue.ref.repository;
  const scope = useMemo(
    () => ({ workspaceId: props.project, repository }),
    [props.project, repository],
  );
  // Ticking a task box edits the body, guarded by the version it was read at.
  const tasks = useTaskSave(
    issue.permissions.edit
      ? (body: string) =>
          writes
            .write({
              action: "edit",
              number: issue.ref.number,
              expectedUpdatedAt: issue.updatedAt,
              title: issue.title,
              body,
            })
            .then((written) => written !== undefined)
      : undefined,
    `${issue.ref.number}:${issue.updatedAt}`,
  );
  return (
    <ForgeContentScope value={scope}>
      <div className={`${readable} pt-6 pb-16`}>
        <Header project={props.project} issue={issue} onBack={props.onBack} />
        <IssueActionsStrip project={props.project} issue={issue} writes={writes} />
        <div className="mt-6 border-t border-border pt-5">
          {issue.body.trim() ? (
            <ForgeProse text={issue.body} tasks={tasks} className="text-ui" />
          ) : (
            <p className="text-ui text-subtle-foreground">No description.</p>
          )}
        </div>
        <IssueTimeline
          project={props.project}
          repository={props.repository}
          number={issue.ref.number}
        />
        <IssueComposer project={props.project} issue={issue} writes={writes} />
      </div>
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
  const choice = useProjectChoice(props.project);
  const back = useBackToList("/issues", props.project, props.back);
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
                seed={
                  props.repo
                    ? undefined
                    : cachedRow(cache, props.project, "issueList", props.number)
                }
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
