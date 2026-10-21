import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChatCircleIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  RecordIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { formatAge } from "@ace/ui-core";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import type { LinkedThread } from "./linked-threads.ts";

/** A two-line row of the sidebar list: title over number, author and age. */
const rowClass = cn(
  "group flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors duration-(--motion-fast)",
  "hover:bg-sidebar-accent focus-ring-inset",
  "data-[status=active]:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent",
);

const prStateWords = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const;

/** The checks of a PR's head as a glyph with its word for assistive tech; nothing when none ran. */
function ChecksGlyph(props: { ci: ForgePrRow["ci"] }) {
  if (props.ci === "success")
    return (
      <span data-tone="done" className="text-(--tone-text)" title="Checks passed">
        <CheckIcon aria-label="Checks passed" size={12} weight="bold" />
      </span>
    );
  if (props.ci === "failure")
    return (
      <span data-tone="failed" className="text-(--tone-text)" title="Checks failing">
        <XIcon aria-label="Checks failing" size={12} weight="bold" />
      </span>
    );
  if (props.ci === "pending")
    return (
      <span title="Checks running">
        <ClockIcon aria-label="Checks running" size={12} />
      </span>
    );
  return null;
}

function Meta(props: { children: ReactNode; trailing: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{props.children}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-subtle-foreground">
        {props.trailing}
      </span>
    </span>
  );
}

function Linked(props: { thread: LinkedThread | undefined }) {
  if (!props.thread) return null;
  return (
    <span title={`Thread: ${props.thread.title}`}>
      <ChatsCircleIcon aria-label={`Thread: ${props.thread.title}`} size={12} />
    </span>
  );
}

function Age(props: { at: string }) {
  const now = useNow();
  const at = Date.parse(props.at);
  if (!Number.isFinite(at)) return null;
  return (
    <time dateTime={props.at} className="w-7 text-right tabular-nums">
      {formatAge(at, now)}
    </time>
  );
}

export function PrListRow(props: {
  project: string;
  row: ForgePrRow;
  thread?: LinkedThread | undefined;
}) {
  const { row } = props;
  return (
    <Link
      to="/pulls/$project/$number"
      params={{ project: props.project, number: String(row.ref.number) }}
      className={rowClass}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" title={prStateWords[row.state]}>
          <PullRequestGlyph state={row.state} size={14} />
        </span>
        <span className="sr-only">{prStateWords[row.state]}</span>
        <span data-view-row-title="" className="min-w-0 flex-1 truncate text-ui font-medium">
          {row.title}
        </span>
      </span>
      <Meta
        trailing={
          <>
            <ChecksGlyph ci={row.ci} />
            <Linked thread={props.thread} />
            {!!row.commentCount && (
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <ChatCircleIcon aria-hidden size={12} />
                <span aria-label={`${row.commentCount} comments`}>{row.commentCount}</span>
              </span>
            )}
            <Age at={row.updatedAt} />
          </>
        }
      >
        <span className="shrink-0 tabular-nums">#{row.ref.number}</span>
        <span className="truncate">{row.author}</span>
      </Meta>
    </Link>
  );
}

export function IssueStateGlyph(props: { state: ForgeIssueRow["state"]; size: number }) {
  return props.state === "open" ? (
    <span data-tone="done" className="text-(--tone-text)">
      <RecordIcon aria-hidden size={props.size} />
    </span>
  ) : (
    <span data-tone="waiting" className="text-(--tone-text)">
      <CheckCircleIcon aria-hidden size={props.size} />
    </span>
  );
}

export function IssueListRow(props: {
  project: string;
  row: ForgeIssueRow;
  thread?: LinkedThread | undefined;
}) {
  const { row } = props;
  return (
    <Link
      to="/issues/$project/$number"
      params={{ project: props.project, number: String(row.ref.number) }}
      className={rowClass}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0" title={row.state === "open" ? "Open" : "Closed"}>
          <IssueStateGlyph state={row.state} size={14} />
        </span>
        <span className="sr-only">{row.state === "open" ? "Open" : "Closed"}</span>
        <span data-view-row-title="" className="min-w-0 flex-1 truncate text-ui font-medium">
          {row.title}
        </span>
      </span>
      <Meta
        trailing={
          <>
            <Linked thread={props.thread} />
            <Age at={row.updatedAt} />
          </>
        }
      >
        <span className="shrink-0 tabular-nums">#{row.ref.number}</span>
        <span className="shrink-0">{row.author}</span>
        {row.labels.length > 0 && <span className="truncate">· {row.labels.join(", ")}</span>}
      </Meta>
    </Link>
  );
}
