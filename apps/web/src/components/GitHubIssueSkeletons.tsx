"use client";

import { cn } from "~/lib/utils";
import { Skeleton } from "./ui/skeleton";

export function GitHubIssueListSkeleton({
  count = 8,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 py-1", className)}>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={`issue-list-skeleton-${index}`}
          className="flex items-start gap-2 rounded-md border border-border/20 px-2 py-2"
        >
          <Skeleton className="mt-0.5 size-3.5 rounded-sm" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-3 rounded-full" />
              <Skeleton className="h-3 w-[78%] rounded-full" />
            </div>
            <div className="flex items-center gap-1.5 ps-[1.125rem]">
              <Skeleton className="h-2.5 w-10 rounded-full" />
              <Skeleton className="h-2.5 w-12 rounded-full" />
            </div>
            <div className="flex gap-1 ps-[1.125rem]">
              <Skeleton className="h-2.5 w-14 rounded-full" />
              <Skeleton className="h-2.5 w-10 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function IssueMarkdownSkeleton({
  lineCount = 7,
  className,
}: {
  lineCount?: number;
  className?: string;
}) {
  const widths = ["w-[92%]", "w-[78%]", "w-[88%]", "w-[72%]", "w-[84%]", "w-[66%]", "w-[76%]"];
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: lineCount }, (_, index) => (
        <Skeleton
          key={`issue-markdown-skeleton-${index}`}
          className={cn("h-3 rounded-full", widths[index % widths.length])}
        />
      ))}
    </div>
  );
}

export function GitHubIssueThreadSkeleton({
  className,
  commentCount = 2,
}: {
  className?: string;
  commentCount?: number;
}) {
  return (
    <div className={cn("space-y-5", className)}>
      <div className="rounded-lg border border-border/40 bg-muted/10 px-4 py-3 dark:bg-muted/5">
        <IssueMarkdownSkeleton lineCount={8} />
      </div>

      <div className="space-y-2">
        <Skeleton className="h-3 w-24 rounded-full" />
        {Array.from({ length: commentCount }, (_, index) => (
          <div
            key={`issue-comment-skeleton-${index}`}
            className="rounded-lg border border-border/35 bg-background/50 px-4 py-3 dark:bg-background/20"
          >
            <div className="mb-3 flex items-center gap-2">
              <Skeleton className="h-2.5 w-20 rounded-full" />
              <Skeleton className="h-2.5 w-12 rounded-full" />
              <Skeleton className="ml-auto size-3 rounded-full" />
            </div>
            <IssueMarkdownSkeleton lineCount={5} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function GitHubIssuePreviewHeaderSkeleton({ issueNumber }: { issueNumber: number }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <Skeleton className="size-3.5 rounded-full" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
            #{issueNumber}
          </span>
          <Skeleton className="h-4 w-[24rem] max-w-[60vw] rounded-full" />
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Skeleton className="h-[18px] w-12 rounded-full" />
        <Skeleton className="h-2.5 w-28 rounded-full" />
        <Skeleton className="h-2.5 w-12 rounded-full" />
      </div>
    </div>
  );
}

export function ThreadHistoryLoadingNotice() {
  return (
    <div className="sticky top-0 z-10 mb-3 flex justify-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-border/50 bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur-sm">
        <Skeleton className="size-2.5 rounded-full" />
        <Skeleton className="h-2.5 w-28 rounded-full" />
        <Skeleton className="hidden h-2.5 w-16 rounded-full sm:block" />
        <span className="sr-only">Loading full history</span>
      </div>
    </div>
  );
}
