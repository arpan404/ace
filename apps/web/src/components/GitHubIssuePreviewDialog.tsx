"use client";

import type { GitHubIssue } from "@ace/contracts";
import { useQuery } from "@tanstack/react-query";
import { CircleDotIcon, CircleXIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { gitGitHubIssueThreadQueryOptions, gitGitHubIssuesQueryOptions } from "~/lib/gitReactQuery";
import { IssueMarkdown, formatIssueRelativeTime } from "./IssueMarkdown";
import {
  GitHubIssuePreviewHeaderSkeleton,
  GitHubIssueThreadSkeleton,
} from "./GitHubIssueSkeletons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogPopup } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";

export interface GitHubIssuePreviewDialogProps {
  open: boolean;
  issueNumber: number;
  cwd: string | null;
  onOpenChange: (open: boolean) => void;
}

export function GitHubIssuePreviewDialog({
  open,
  issueNumber,
  cwd,
  onOpenChange,
}: GitHubIssuePreviewDialogProps) {
  const [resolvedIssue, setResolvedIssue] = useState<GitHubIssue | null>(null);

  const issuesQuery = useQuery(
    gitGitHubIssuesQueryOptions({
      cwd,
      limit: 120,
      state: "all",
      query: `#${issueNumber}`,
      enabled: open && issueNumber > 0,
    }),
  );

  const issueMetadata = useMemo(() => {
    return issuesQuery.data?.issues?.find((i) => i.number === issueNumber) ?? null;
  }, [issuesQuery.data?.issues, issueNumber]);

  useEffect(() => {
    if (issueMetadata) setResolvedIssue(issueMetadata);
  }, [issueMetadata]);

  const threadQuery = useQuery(
    gitGitHubIssueThreadQueryOptions({
      cwd,
      issueNumber: open ? issueNumber : null,
      enabled: open && issueNumber > 0,
    }),
  );
  const thread = threadQuery.data?.issue;
  const displayIssue = resolvedIssue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        className="flex h-[min(40rem,88vh)] min-h-[16rem] max-w-[min(52rem,94vw)] gap-0 overflow-hidden p-0"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex shrink-0 items-start justify-between border-b border-border/50 px-5 py-3.5">
            {displayIssue ? (
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {displayIssue.state === "open" ? (
                    <CircleDotIcon className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleXIcon className="size-3.5 shrink-0 text-violet-500" />
                  )}
                  <h2 className="text-sm font-semibold leading-snug tracking-tight text-foreground">
                    <span className="font-mono text-xs font-normal text-muted-foreground/70 tabular-nums">
                      #{issueNumber}
                    </span>{" "}
                    {displayIssue.title}
                  </h2>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  <Badge
                    variant={displayIssue.state === "open" ? "success" : "outline"}
                    size="sm"
                    className="h-[18px] rounded-full px-1.5 text-[10px] font-medium capitalize"
                  >
                    {displayIssue.state}
                  </Badge>
                  <span>
                    Opened by{" "}
                    <span className="font-medium text-foreground/90">
                      {displayIssue.author?.login ?? "unknown"}
                    </span>
                  </span>
                  <span className="text-border/60">·</span>
                  <span>{formatIssueRelativeTime(displayIssue.createdAt)}</span>
                  {displayIssue.labels.length > 0 ? (
                    <>
                      <span className="text-border/60">·</span>
                      {displayIssue.labels.slice(0, 4).map((label) => (
                        <Badge
                          key={label.name}
                          variant="secondary"
                          size="sm"
                          className="h-[18px] rounded-full px-1.5 text-[10px] font-normal"
                        >
                          {label.name}
                        </Badge>
                      ))}
                      {displayIssue.labels.length > 4 ? (
                        <span className="text-[10px]">+{displayIssue.labels.length - 4}</span>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            ) : (
              <GitHubIssuePreviewHeaderSkeleton issueNumber={issueNumber} />
            )}
            <div className="ms-3 flex shrink-0 items-center gap-1">
              {displayIssue?.url ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1 rounded-md text-xs"
                  render={<a href={displayIssue.url} target="_blank" rel="noreferrer" />}
                >
                  GitHub
                  <ExternalLinkIcon className="size-3 opacity-60" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="size-7 rounded-md p-0"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          {/* Body */}
          <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
            <div className="px-5 py-4 pb-6">
              {threadQuery.isFetching && !thread ? (
                <GitHubIssueThreadSkeleton />
              ) : thread ? (
                <div className="space-y-4">
                  {/* Description */}
                  <div className="rounded-lg border border-border/40 bg-muted/10 px-4 py-3 dark:bg-muted/5">
                    <IssueMarkdown
                      text={thread.body?.trim().length ? thread.body : "No description provided."}
                      cwd={cwd}
                    />
                  </div>

                  {/* Comments */}
                  {thread.comments.length > 0 ? (
                    <div>
                      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                        Comments ({thread.comments.length})
                      </h3>
                      <div className="space-y-2">
                        {thread.comments.map((comment) => (
                          <div
                            key={
                              comment.url ??
                              `${comment.createdAt}-${comment.author?.login ?? "unknown"}`
                            }
                            className="rounded-lg border border-border/35 bg-background/50 px-4 py-3 dark:bg-background/20"
                          >
                            <div className="mb-2 flex items-center gap-2 text-[11px]">
                              <span className="font-semibold text-foreground/85">
                                {comment.author?.login ?? "unknown"}
                              </span>
                              <span className="text-muted-foreground/60">
                                {formatIssueRelativeTime(comment.createdAt)}
                              </span>
                              {comment.url ? (
                                <a
                                  href={comment.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="ml-auto text-muted-foreground/50 transition-colors hover:text-foreground"
                                >
                                  <ExternalLinkIcon className="size-3" />
                                </a>
                              ) : null}
                            </div>
                            <IssueMarkdown
                              text={comment.body?.trim().length ? comment.body : "Empty comment."}
                              cwd={cwd}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="py-12 text-center text-xs text-muted-foreground">
                  Could not load this issue.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
