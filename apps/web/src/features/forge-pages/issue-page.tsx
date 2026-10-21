import {
  ArrowLeftIcon,
  ArrowSquareOutIcon,
  ChatsCircleIcon,
  CopyIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueDetail } from "@ace/protocol";
import { Icon } from "@/components/icon.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "@/boot/open-external.ts";
import { PrAvatar, PrTime } from "@/features/forge/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useSidebarInline } from "@/lib/breakpoints.ts";
import { useForgeBrowse } from "./browse-context.tsx";
import { IssueActionsStrip } from "./issue-actions-strip.tsx";
import { IssueComposer } from "./issue-composer.tsx";
import { IssueTimeline } from "./issue-timeline.tsx";
import { useIssueWrites } from "./issue-writes.ts";
import { useIssueDetail } from "./lists.ts";
import { IssueStateGlyph } from "./rows.tsx";

const chip =
  "inline-flex h-5 max-w-48 items-center truncate rounded-xs bg-surface-1 px-1.5 text-xs text-muted-foreground";

function People(props: { issue: ForgeIssueDetail }) {
  const { issue } = props;
  if (!issue.labels.length && !issue.assignees.length && !issue.milestone) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {issue.labels.map((label) => (
        <span key={label} className={chip}>
          {label}
        </span>
      ))}
      {issue.assignees.length > 0 && (
        <span className="ml-1 inline-flex items-center gap-1">
          {issue.assignees.map((login) => (
            <PrAvatar key={login} name={login} className="size-4 min-w-4" />
          ))}
          <span>{issue.assignees.join(", ")}</span>
        </span>
      )}
      {issue.milestone && <span className="ml-1">{issue.milestone}</span>}
    </div>
  );
}

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

function IssueBody(props: {
  project: string;
  issue: ForgeIssueDetail;
  onBack?: (() => void) | undefined;
}) {
  const { issue } = props;
  const writes = useIssueWrites(props.project, issue.ref.repository);
  return (
    <div className="mx-auto w-full max-w-(--column) px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
      {props.onBack && (
        <IconButton icon={ArrowLeftIcon} label="Back to issues" onClick={props.onBack} />
      )}
      <h2 className="text-2xl font-semibold tracking-title text-foreground">
        {issue.title}{" "}
        <span className="font-normal text-subtle-foreground">#{issue.ref.number}</span>
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-ui text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <IssueStateGlyph state={issue.state} size={14} />
          {issue.state === "open" ? "Open" : "Closed"}
        </span>
        <span aria-hidden className="text-subtle-foreground">
          ·
        </span>
        <span className="font-medium text-foreground/85">{issue.author}</span>
        <span>opened</span>
        <PrTime at={issue.createdAt} />
      </p>
      <People issue={issue} />
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

/** One issue as a page: its description, conversation and the actions GitHub allows. */
export function IssuePage(props: { project: string; number: number }) {
  const browse = useForgeBrowse();
  const navigate = useNavigate();
  const wide = useSidebarInline();
  const toast = useToast();
  const query = useIssueDetail(props.project, props.number);
  const issue = query.data;
  const onBack = wide ? undefined : () => void navigate({ to: "/issues" });
  return (
    <Screen
      title="Issues"
      crumb={browse.projectName(props.project)}
      menu={
        issue && (
          <>
            <MenuItem
              icon={<Icon icon={ArrowSquareOutIcon} />}
              onClick={() =>
                void openExternal(issue.url).catch(() =>
                  toast.error({ title: "Couldn't open GitHub" }),
                )
              }
            >
              Open on GitHub
            </MenuItem>
            <MenuItem
              icon={<Icon icon={CopyIcon} />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(issue.url)
                  .catch(() => toast.error({ title: "Couldn't copy the link" }))
              }
            >
              Copy link
            </MenuItem>
          </>
        )
      }
    >
      <div className="h-full overflow-y-auto">
        {issue ? (
          <IssueBody project={props.project} issue={issue} onBack={onBack} />
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
          <div className="mx-auto w-full max-w-(--column) px-4 pt-6 sm:px-8 sm:pt-10">
            <SkeletonText lines={4} />
          </div>
        )}
      </div>
    </Screen>
  );
}
