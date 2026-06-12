"use client";

import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useMemo } from "react";

import { gitGitHubIssueThreadQueryOptions, gitGitHubIssuesQueryOptions } from "~/lib/gitReactQuery";
import {
  GitHubIssuePreviewHeaderSkeleton,
  GitHubIssueThreadSkeleton,
} from "./GitHubIssueSkeletons";
import {
  GitHubIssueExternalLink,
  GitHubIssueThreadReader,
  GitHubIssueTitleBlock,
} from "./GitHubIssueSurface";
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
  const { data: issuesData } = useQuery(
    gitGitHubIssuesQueryOptions({
      cwd,
      limit: 120,
      state: "all",
      query: `#${issueNumber}`,
      enabled: open && issueNumber > 0,
    }),
  );

  const issueMetadata = useMemo(() => {
    return issuesData?.issues?.find((i) => i.number === issueNumber) ?? null;
  }, [issuesData?.issues, issueNumber]);

  const { data: threadData, isFetching: isThreadFetching } = useQuery(
    gitGitHubIssueThreadQueryOptions({
      cwd,
      issueNumber: open ? issueNumber : null,
      enabled: open && issueNumber > 0,
    }),
  );
  const thread = threadData?.issue;
  const displayIssue = issueMetadata;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        className="flex h-[min(38rem,90vh)] min-h-[18rem] max-w-[min(48rem,calc(100vw-1rem))] gap-0 overflow-hidden border-border/55 bg-popover/68 p-0 shadow-[0_24px_72px_-40px] shadow-black/60 backdrop-blur-2xl supports-[backdrop-filter]:bg-popover/58"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-start justify-between border-b border-border/40 bg-background/18 px-4 py-3 backdrop-blur-xl sm:px-5">
            {displayIssue ? (
              <GitHubIssueTitleBlock
                issue={displayIssue}
                compact
                action={
                  displayIssue.url ? <GitHubIssueExternalLink url={displayIssue.url} /> : null
                }
              />
            ) : (
              <GitHubIssuePreviewHeaderSkeleton issueNumber={issueNumber} />
            )}
            <div className="ms-3 flex shrink-0 items-center gap-1 self-start">
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
            <div className="px-4 py-4 pb-6 sm:px-5">
              {isThreadFetching && !thread ? (
                <GitHubIssueThreadSkeleton />
              ) : thread ? (
                <GitHubIssueThreadReader thread={thread} cwd={cwd} />
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
