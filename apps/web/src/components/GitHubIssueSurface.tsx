"use client";

import type { GitHubIssue, GitHubIssueThread } from "@ace/contracts";
import { ExternalLinkIcon, MessageSquareTextIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { IssueMarkdown } from "./IssueMarkdown";
import { formatIssueRelativeTime } from "./issueTime";

export function GitHubIssueLabelStrip({
  labels,
  limit,
  className,
}: {
  labels: GitHubIssue["labels"];
  limit?: number | undefined;
  className?: string;
}) {
  if (labels.length === 0) {
    return null;
  }
  const visibleLabels = typeof limit === "number" ? labels.slice(0, limit) : labels;
  const hiddenCount = labels.length - visibleLabels.length;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", className)}>
      {visibleLabels.map((label, index) => (
        <span
          key={label.name}
          className="max-w-[12rem] truncate text-[10px] text-muted-foreground/62"
        >
          {index > 0 ? <span className="me-1 text-muted-foreground/35">/</span> : null}
          {label.name}
        </span>
      ))}
      {hiddenCount > 0 ? (
        <span className="text-[10px] text-muted-foreground/50">+{hiddenCount}</span>
      ) : null}
    </div>
  );
}

export function GitHubIssueByline({ issue }: { issue: GitHubIssue | GitHubIssueThread }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/72">
      <span className="capitalize">{issue.state}</span>
      <span className="text-border/70">·</span>
      <span className="min-w-0 truncate font-medium text-foreground/75">
        {issue.author?.login ?? "unknown"}
      </span>
      <span className="text-border/70">·</span>
      <span>{formatIssueRelativeTime(issue.createdAt)}</span>
      <span className="text-border/70">·</span>
      <span>Updated {formatIssueRelativeTime(issue.updatedAt)}</span>
    </div>
  );
}

export function GitHubIssueTitleBlock({
  issue,
  action,
  compact = false,
  actionClassName,
}: {
  issue: GitHubIssue | GitHubIssueThread;
  action?: React.ReactNode;
  compact?: boolean;
  actionClassName?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <h2
            className={cn(
              "min-w-0 flex-1 font-medium leading-[1.45] tracking-tight text-foreground/92",
              compact ? "text-[13px]" : "text-[13px]",
            )}
          >
            <span className="font-mono font-normal text-muted-foreground/70 tabular-nums">
              #{issue.number}
            </span>{" "}
            {issue.title}
          </h2>
        </div>
        {action ? <div className={cn("shrink-0", actionClassName)}>{action}</div> : null}
      </div>
      <div className="mt-2.5 flex min-w-0 flex-col gap-1.5">
        <GitHubIssueByline issue={issue} />
        <GitHubIssueLabelStrip labels={issue.labels} limit={compact ? 4 : undefined} />
      </div>
    </div>
  );
}

export function GitHubIssueExternalLink({ url }: { url: string }) {
  return (
    <Button
      variant="outline"
      size="icon-sm"
      className="size-7 text-muted-foreground hover:text-foreground"
      render={<a href={url} target="_blank" rel="noreferrer" />}
      aria-label="Open issue on GitHub"
      title="Open issue on GitHub"
    >
      <ExternalLinkIcon className="size-3.5 opacity-70" />
    </Button>
  );
}

export function GitHubIssueThreadReader({
  thread,
  cwd,
  className,
}: {
  thread: GitHubIssueThread;
  cwd: string | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-5", className)}>
      <article className="border-b border-border/35 pb-5">
        <IssueMarkdown
          text={thread.body?.trim().length ? thread.body : "No description provided."}
          cwd={cwd}
          className="text-[12px] leading-5 text-foreground/72 [&_h1]:text-[12px] [&_h2]:text-[12px] [&_h3]:text-[12px] [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2"
        />
      </article>

      {thread.comments.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-muted-foreground/70">
            <MessageSquareTextIcon className="size-3" />
            Comments
            <span className="font-mono tracking-normal text-muted-foreground/55 tabular-nums">
              {thread.comments.length}
            </span>
          </div>
          <div className="space-y-2">
            {thread.comments.map((comment) => (
              <article
                key={comment.url ?? `${comment.createdAt}-${comment.author?.login ?? "unknown"}`}
                className="border-b border-border/30 pb-4 last:border-b-0"
              >
                <div className="mb-2 flex min-w-0 items-center gap-2 text-[11px]">
                  <span className="min-w-0 truncate font-semibold text-foreground/85">
                    {comment.author?.login ?? "unknown"}
                  </span>
                  <span className="shrink-0 text-muted-foreground/60">
                    {formatIssueRelativeTime(comment.createdAt)}
                  </span>
                  {comment.url ? (
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
                      aria-label="Open comment on GitHub"
                    >
                      <ExternalLinkIcon className="size-3" />
                    </a>
                  ) : null}
                </div>
                <IssueMarkdown
                  text={comment.body?.trim().length ? comment.body : "Empty comment."}
                  cwd={cwd}
                  className="text-[12px] leading-5 text-foreground/72 [&_h1]:text-[12px] [&_h2]:text-[12px] [&_h3]:text-[12px] [&_p]:my-2"
                />
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
