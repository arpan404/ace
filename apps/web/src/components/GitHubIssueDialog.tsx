"use client";

import type { GitHubIssue } from "@ace/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { fetchGitHubIssueMarkdownImages } from "~/lib/chat/githubIssueImages";
import { buildGitHubIssuePromptFromThread } from "~/lib/chat/githubIssuePrompt";
import { gitGitHubIssueThreadQueryOptions, gitGitHubIssuesQueryOptions } from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { GitHubIcon } from "./Icons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";

function formatIssueRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  if (days < 30) {
    const w = Math.floor(days / 7);
    return `${w}w ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export interface GitHubIssueDialogProps {
  open: boolean;
  cwd: string | null;
  onOpenChange: (open: boolean) => void;
  onFixIssue: (payload: {
    prompt: string;
    images: ComposerImageAttachment[];
  }) => void | Promise<void>;
}

export function GitHubIssueDialog({ open, cwd, onOpenChange, onFixIssue }: GitHubIssueDialogProps) {
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, searchDebouncer] = useDebouncedValue(search, { wait: 320 }, (state) => ({
    isPending: state.isPending,
  }));
  const [solvingIssueNumber, setSolvingIssueNumber] = useState<number | null>(null);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSearch("");
    setSolvingIssueNumber(null);
    setSelectedIssueNumber(null);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const trimmedDebouncedSearch = debouncedSearch.trim();
  const issuesQuery = useQuery(
    gitGitHubIssuesQueryOptions({
      cwd,
      limit: 40,
      ...(trimmedDebouncedSearch.length > 0 ? { query: trimmedDebouncedSearch } : {}),
      enabled: open,
    }),
  );

  const issues = issuesQuery.data?.issues ?? [];
  const isSearchStale = searchDebouncer.state.isPending && search.trim() !== trimmedDebouncedSearch;

  const selectedIssue = useMemo(() => {
    if (selectedIssueNumber === null) {
      return issues[0] ?? null;
    }
    return issues.find((issue) => issue.number === selectedIssueNumber) ?? issues[0] ?? null;
  }, [selectedIssueNumber, issues]);

  useEffect(() => {
    if (selectedIssue && selectedIssueNumber === null) {
      setSelectedIssueNumber(selectedIssue.number);
    }
  }, [selectedIssue, selectedIssueNumber]);

  const threadQuery = useQuery(
    gitGitHubIssueThreadQueryOptions({
      cwd,
      issueNumber: selectedIssue?.number ?? null,
      enabled: open && selectedIssue !== null,
    }),
  );

  const handleSolve = useCallback(
    async (issue: GitHubIssue) => {
      if (!cwd || solvingIssueNumber !== null) {
        return;
      }
      setSolvingIssueNumber(issue.number);
      try {
        const { issue: thread } = await queryClient.fetchQuery(
          gitGitHubIssueThreadQueryOptions({
            cwd,
            issueNumber: issue.number,
            enabled: true,
          }),
        );
        const images = await fetchGitHubIssueMarkdownImages(thread);
        const prompt = buildGitHubIssuePromptFromThread(thread);
        await onFixIssue({ prompt, images });
      } finally {
        setSolvingIssueNumber(null);
      }
    },
    [cwd, onFixIssue, queryClient, solvingIssueNumber],
  );

  const errorMessage =
    issuesQuery.isError && issuesQuery.error instanceof Error
      ? issuesQuery.error.message
      : issuesQuery.isError
        ? "Failed to load GitHub issues."
        : null;

  const thread = threadQuery.data?.issue;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (solvingIssueNumber === null) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup
        showCloseButton
        className="flex max-h-[min(42rem,92vh)] min-h-0 max-w-5xl gap-0 overflow-hidden p-0"
      >
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(15.5rem,26%)_minmax(0,1fr)] overflow-hidden">
          {/* Issue list — GitHub-style dense sidebar */}
          <div className="flex min-h-0 flex-col border-e border-border/60 bg-muted/15 dark:bg-muted/10">
            <div className="shrink-0 border-b border-border/60 px-4 py-3 pe-12">
              <DialogHeader className="gap-0.5 p-0 text-start">
                <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-tight">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-background/90 shadow-sm ring-1 ring-border/50 dark:bg-background/50">
                    <GitHubIcon className="size-4 opacity-90" />
                  </span>
                  Issues
                </DialogTitle>
                <p className="text-muted-foreground text-xs font-normal leading-snug">
                  Open issues in this repository
                </p>
              </DialogHeader>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3 pt-2">
              <label className="relative block shrink-0 px-1">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/75"
                />
                <Input
                  ref={searchInputRef}
                  placeholder="Search issues"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                  }}
                  className={cn(
                    "h-9 rounded-md border-border/70 bg-background/90 ps-9 text-sm shadow-sm",
                    "placeholder:text-muted-foreground/65",
                    "focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/20",
                  )}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                    }
                  }}
                />
              </label>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 font-medium text-foreground/75",
                    isSearchStale && "opacity-55",
                  )}
                >
                  {issuesQuery.isFetching && !issuesQuery.isPending ? (
                    <Spinner className="size-3" />
                  ) : null}
                  {issues.length} open
                  {trimmedDebouncedSearch.length > 0 ? ` · “${trimmedDebouncedSearch}”` : ""}
                </span>
                <span className="text-muted-foreground/80">· max 40</span>
              </div>

              {errorMessage ? (
                <div className="mx-1 shrink-0 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {errorMessage}
                </div>
              ) : null}

              <ScrollArea className="min-h-0 flex-1 px-1" scrollbarGutter scrollFade>
                <div role="listbox" aria-label="Issues" className="pb-1">
                  {issuesQuery.isPending && issues.length === 0 ? (
                    <div className="flex flex-col gap-px py-1">
                      {Array.from({ length: 8 }).map((_, index) => (
                        <div
                          key={index}
                          className="h-[3.25rem] animate-pulse rounded-md bg-muted/45 dark:bg-muted/25"
                        />
                      ))}
                    </div>
                  ) : issues.length === 0 ? (
                    <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                      {trimmedDebouncedSearch.length > 0
                        ? "No issues match your search."
                        : "No open issues found."}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border/50 bg-background/40 dark:bg-background/20">
                      {issues.map((issue) => {
                        const isActive = selectedIssue?.number === issue.number;
                        return (
                          <button
                            key={issue.number}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            className={cn(
                              "flex w-full flex-col gap-0.5 border-b border-border/35 px-3 py-2.5 text-start transition-colors last:border-b-0",
                              "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                              isActive
                                ? "bg-primary/[0.08] ring-1 ring-inset ring-primary/25 dark:bg-primary/[0.12]"
                                : "",
                            )}
                            onClick={() => setSelectedIssueNumber(issue.number)}
                          >
                            <div className="flex min-w-0 items-baseline gap-2">
                              <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                                #{issue.number}
                              </span>
                              <span className="min-w-0 truncate text-[13px] font-medium leading-tight text-foreground">
                                {issue.title}
                              </span>
                            </div>
                            <div className="flex min-w-0 items-center gap-2 ps-[2.75rem]">
                              {issue.labels.length > 0 ? (
                                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                                  {issue.labels.slice(0, 2).map((label) => (
                                    <span
                                      key={label.name}
                                      className="max-w-[6.5rem] truncate rounded-full bg-muted/80 px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                                    >
                                      {label.name}
                                    </span>
                                  ))}
                                  {issue.labels.length > 2 ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      +{issue.labels.length - 2}
                                    </span>
                                  ) : null}
                                </div>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/80">
                                  {formatIssueRelativeTime(issue.updatedAt) || "—"}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          {/* Detail — thread + actions */}
          <div className="flex min-h-0 min-w-0 flex-col bg-popover">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {selectedIssue ? (
                <>
                  <div className="shrink-0 border-b border-border/60 px-6 pb-4 pt-5 pe-14">
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-start justify-between gap-2 gap-y-1">
                        <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug tracking-tight text-foreground">
                          <span className="text-muted-foreground font-mono text-base font-normal tabular-nums">
                            #{selectedIssue.number}
                          </span>{" "}
                          {selectedIssue.title}
                        </h2>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5 rounded-md"
                          render={<a href={selectedIssue.url} target="_blank" rel="noreferrer" />}
                        >
                          GitHub
                          <ExternalLinkIcon className="size-3.5 opacity-70" />
                        </Button>
                      </div>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <Badge
                          variant={selectedIssue.state === "open" ? "success" : "outline"}
                          size="sm"
                          className="h-5 rounded-full px-2 text-[11px] font-normal capitalize"
                        >
                          {selectedIssue.state}
                        </Badge>
                        <span className="text-border hidden sm:inline">·</span>
                        <span>
                          Opened by{" "}
                          <span className="text-foreground/90 font-medium">
                            {selectedIssue.author?.login ?? "unknown"}
                          </span>
                        </span>
                        <span className="text-border">·</span>
                        <span>{formatIssueRelativeTime(selectedIssue.createdAt)}</span>
                      </div>
                      {selectedIssue.labels.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedIssue.labels.map((label) => (
                            <Badge
                              key={label.name}
                              variant="secondary"
                              size="sm"
                              className="font-normal"
                            >
                              {label.name}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
                    <div className="space-y-6 px-6 py-4 pb-6">
                      {threadQuery.isFetching && !thread ? (
                        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                          <Spinner className="size-4" />
                          Loading thread…
                        </div>
                      ) : thread ? (
                        <>
                          <section>
                            <h3 className="text-foreground/90 mb-2 text-xs font-semibold uppercase tracking-wide">
                              Description
                            </h3>
                            <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 text-sm leading-relaxed text-muted-foreground dark:bg-muted/10">
                              <p className="whitespace-pre-wrap break-words">
                                {thread.body?.trim().length
                                  ? thread.body
                                  : "No description provided."}
                              </p>
                            </div>
                          </section>
                          {thread.comments.length > 0 ? (
                            <section>
                              <h3 className="text-foreground/90 mb-3 text-xs font-semibold uppercase tracking-wide">
                                Comments ({thread.comments.length})
                              </h3>
                              <ul className="space-y-3">
                                {thread.comments.map((comment, index) => (
                                  <li
                                    key={`${comment.createdAt}-${index}`}
                                    className="rounded-lg border border-border/45 bg-background/60 px-4 py-3 dark:bg-background/25"
                                  >
                                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                                      <span className="font-semibold text-foreground/90">
                                        {comment.author?.login ?? "unknown"}
                                      </span>
                                      <span className="text-muted-foreground">
                                        {formatIssueRelativeTime(comment.createdAt)}
                                      </span>
                                      {comment.url ? (
                                        <a
                                          href={comment.url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1"
                                        >
                                          <ExternalLinkIcon className="size-3" />
                                        </a>
                                      ) : null}
                                    </div>
                                    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                                      {comment.body?.trim().length
                                        ? comment.body
                                        : "Empty comment."}
                                    </p>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          ) : null}
                        </>
                      ) : (
                        <p className="py-12 text-center text-sm text-muted-foreground">
                          Could not load this issue.
                        </p>
                      )}
                    </div>
                  </ScrollArea>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center px-6">
                  <p className="text-center text-sm text-muted-foreground">
                    Select an issue from the list
                  </p>
                </div>
              )}
            </div>

            <DialogFooter className="shrink-0 border-t border-border/60 bg-muted/20 px-6 py-3 dark:bg-muted/10 sm:py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-md"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={!selectedIssue || solvingIssueNumber !== null}
                className="min-w-[7.5rem] rounded-md"
                onClick={() => {
                  if (selectedIssue) {
                    void handleSolve(selectedIssue);
                  }
                }}
              >
                {solvingIssueNumber !== null ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="size-3.5" />
                    Sending…
                  </span>
                ) : (
                  "Solve with agent"
                )}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
