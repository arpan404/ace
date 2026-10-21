import { ArrowSquareOutIcon, ChatsCircleIcon, CopyIcon } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueDetail } from "@ace/protocol";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { PrTime } from "@/features/forge/index.ts";
import { IssueActionsStrip } from "./issue-actions-strip.tsx";
import { IssueComposer } from "./issue-composer.tsx";
import { IssueTimeline } from "./issue-timeline.tsx";
import { useIssueWrites } from "./issue-writes.ts";
import { useIssueDetail } from "./lists.ts";
import { Avatars, LabelPill, StateBadge } from "./marks.tsx";

/** The threads working on this issue, and a way to start one from it. */
function Threads(props: { project: string; issue: ForgeIssueDetail }) {
  const navigate = useNavigate();
  const threads = props.issue.relatedThreads.filter((thread) => !thread.archived);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {threads.map((thread) => (
        <Link
          key={thread.id}
          to="/t/$threadId"
          params={{ threadId: thread.id }}
          className="inline-flex h-7 max-w-72 items-center gap-1.5 rounded-md px-2 text-ui text-muted-foreground focus-ring hover:bg-hover hover:text-foreground"
        >
          <ChatsCircleIcon aria-hidden size={14} className="shrink-0" />
          <span className="truncate">{thread.title}</span>
        </Link>
      ))}
      <Button
        size="sm"
        onClick={() =>
          void navigate({ to: "/new", search: { project: props.project, issue: props.issue.url } })
        }
      >
        New thread
      </Button>
    </div>
  );
}

function Header(props: {
  issue: ForgeIssueDetail;
  labelColors: Record<string, string> | undefined;
}) {
  const { issue } = props;
  const toast = useToast();
  const colors = issue.labelColors ?? props.labelColors;
  return (
    <>
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-title text-foreground">
          {issue.title}{" "}
          <span className="font-normal text-subtle-foreground">#{issue.ref.number}</span>
        </h2>
        <IconButton
          size="sm"
          icon={CopyIcon}
          label="Copy link"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(issue.url)
              .catch(() => toast.error({ title: "Couldn't copy the link" }))
          }
        />
        <IconButton
          size="sm"
          icon={ArrowSquareOutIcon}
          label="Open on GitHub"
          onClick={() =>
            void openExternal(issue.url).catch(() => toast.error({ title: "Couldn't open GitHub" }))
          }
        />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-muted-foreground">
        <StateBadge kind="issue" state={issue.state} />
        <span className="font-medium text-foreground/85">{issue.author}</span>
        <span>opened</span>
        <PrTime at={issue.createdAt} />
      </p>
      {(issue.labels.length > 0 || issue.assignees.length > 0 || issue.milestone) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {issue.labels.map((label) => (
            <LabelPill key={label} name={label} color={colors?.[label]} />
          ))}
          {issue.assignees.length > 0 && (
            <span className="ml-1 inline-flex items-center gap-1.5">
              <Avatars people={issue.assignees} avatars={issue.avatars} label="Assignees" />
              <span>{issue.assignees.join(", ")}</span>
            </span>
          )}
          {issue.milestone && <span className="ml-1">{issue.milestone}</span>}
        </div>
      )}
    </>
  );
}

function IssueBody(props: {
  project: string;
  issue: ForgeIssueDetail;
  labelColors: Record<string, string> | undefined;
}) {
  const { issue } = props;
  const writes = useIssueWrites(props.project, issue.ref.repository);
  return (
    <div className="px-5 pt-5 pb-16">
      <Header issue={issue} labelColors={props.labelColors} />
      <Threads project={props.project} issue={issue} />
      <IssueActionsStrip project={props.project} issue={issue} writes={writes} />
      <div className="mt-6 border-t border-border pt-5">
        {issue.body.trim() ? (
          <Prose text={issue.body} className="text-ui" />
        ) : (
          <p className="text-ui text-subtle-foreground">No description.</p>
        )}
      </div>
      <IssueTimeline project={props.project} number={issue.ref.number} />
      <IssueComposer issue={issue} writes={writes} />
    </div>
  );
}

/** The open issue beside the list: its description, conversation and the actions GitHub allows. */
export function IssuePanel(props: {
  project: string;
  number: number;
  /** The list row's label colours, for a detail read that came without them. */
  labelColors?: Record<string, string> | undefined;
}) {
  const query = useIssueDetail(props.project, props.number);
  const issue = query.data;
  return (
    <article aria-label={`Issue #${props.number}`} className="absolute inset-0 overflow-y-auto">
      {issue ? (
        <IssueBody project={props.project} issue={issue} labelColors={props.labelColors} />
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
        <div className="px-5 pt-5">
          <SkeletonText lines={4} />
        </div>
      )}
    </article>
  );
}
