"use client";

import type { GitHubIssue } from "@ace/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  CheckIcon,
  CircleDotIcon,
  CircleXIcon,
  ExternalLinkIcon,
  FilterIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { buildGitHubIssueSelectionPayload } from "~/lib/chat/githubIssueSelection";
import {
  type GitHubIssueListStateFilter,
  gitGitHubIssueThreadQueryOptions,
  gitGitHubIssuesQueryOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import ChatMarkdown from "./ChatMarkdown";
import { GitHubIcon } from "./Icons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";

const EMPTY_ISSUES: readonly GitHubIssue[] = [];
const ISSUE_SKELETON_KEYS = [
  "skeleton-1",
  "skeleton-2",
  "skeleton-3",
  "skeleton-4",
  "skeleton-5",
  "skeleton-6",
  "skeleton-7",
  "skeleton-8",
] as const;
const ISSUE_STATE_FILTERS: ReadonlyArray<GitHubIssueListStateFilter> = ["open", "closed", "all"];
const ISSUE_LIMIT_OPTIONS = [40, 80, 120] as const;

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
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toggleListValue(values: ReadonlyArray<number>, next: number): number[] {
  return values.includes(next) ? values.filter((value) => value !== next) : [...values, next];
}

function normalizeIssueNumbers(issueNumbers: ReadonlyArray<number>): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const issueNumber of issueNumbers) {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || seen.has(issueNumber)) {
      continue;
    }
    seen.add(issueNumber);
    normalized.push(issueNumber);
  }
  return normalized;
}

export interface GitHubIssueDialogProps {
  open: boolean;
  cwd: string | null;
  initialIssueNumber?: number | null;
  initialSelectedIssueNumbers?: ReadonlyArray<number>;
  onOpenChange: (open: boolean) => void;
  onFixIssue: (payload: {
    prompt: string;
    images: ComposerImageAttachment[];
  }) => void | Promise<void>;
}

export function GitHubIssueDialog({
  open,
  cwd,
  initialIssueNumber = null,
  initialSelectedIssueNumbers = [],
  onOpenChange,
  onFixIssue,
}: GitHubIssueDialogProps) {
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, searchDebouncer] = useDebouncedValue(search, { wait: 320 }, (state) => ({
    isPending: state.isPending,
  }));
  const [isSolving, setIsSolving] = useState(false);
  const [focusedIssueNumber, setFocusedIssueNumber] = useState<number | null>(null);
  const [selectedIssueNumbers, setSelectedIssueNumbers] = useState<number[]>([]);
  const [stateFilter, setStateFilter] = useState<GitHubIssueListStateFilter>("open");
  const [issueLimit, setIssueLimit] = useState<(typeof ISSUE_LIMIT_OPTIONS)[number]>(80);
  const [labelFilters, setLabelFilters] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSearch(initialIssueNumber !== null ? `#${initialIssueNumber}` : "");
    setIsSolving(false);
    setStateFilter(initialIssueNumber !== null ? "all" : "open");
    setIssueLimit(80);
    setLabelFilters([]);
    setFocusedIssueNumber(initialIssueNumber);
    setSelectedIssueNumbers(normalizeIssueNumbers(initialSelectedIssueNumbers));
  }, [initialIssueNumber, initialSelectedIssueNumbers, open]);

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
      limit: issueLimit,
      state: stateFilter,
      labels: labelFilters,
      ...(trimmedDebouncedSearch.length > 0 ? { query: trimmedDebouncedSearch } : {}),
      enabled: open,
    }),
  );

  const issues = issuesQuery.data?.issues ?? EMPTY_ISSUES;
  const isSearchStale = searchDebouncer.state.isPending && search.trim() !== trimmedDebouncedSearch;
  const issueByNumber = useMemo(
    () => new Map(issues.map((issue) => [issue.number, issue])),
    [issues],
  );
  const selectedIssueNumberSet = useMemo(
    () => new Set(normalizeIssueNumbers(selectedIssueNumbers)),
    [selectedIssueNumbers],
  );
  const availableLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .toSorted((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return left[0].localeCompare(right[0]);
      })
      .slice(0, 24)
      .map(([label, count]) => ({ label, count }));
  }, [issues]);

  const focusedIssue = useMemo(() => {
    if (focusedIssueNumber !== null) {
      return issueByNumber.get(focusedIssueNumber) ?? issues[0] ?? null;
    }
    return issues[0] ?? null;
  }, [focusedIssueNumber, issueByNumber, issues]);

  useEffect(() => {
    if (focusedIssue && focusedIssueNumber === null) {
      setFocusedIssueNumber(focusedIssue.number);
    }
  }, [focusedIssue, focusedIssueNumber]);

  const threadQuery = useQuery(
    gitGitHubIssueThreadQueryOptions({
      cwd,
      issueNumber: focusedIssue?.number ?? null,
      enabled: open && focusedIssue !== null,
    }),
  );

  const selectedIssueNumbersForSolve = useMemo(() => {
    if (selectedIssueNumberSet.size > 0) {
      return Array.from(selectedIssueNumberSet);
    }
    return focusedIssue ? [focusedIssue.number] : [];
  }, [focusedIssue, selectedIssueNumberSet]);

  const handleToggleIssueSelection = useCallback((issueNumber: number) => {
    setSelectedIssueNumbers((existing) => toggleListValue(existing, issueNumber));
  }, []);

  const handleToggleLabelFilter = useCallback((label: string) => {
    setLabelFilters((existing) =>
      existing.includes(label) ? existing.filter((value) => value !== label) : [...existing, label],
    );
  }, []);

  const handleSolveSelectedIssues = useCallback(async () => {
    if (!cwd || isSolving || selectedIssueNumbersForSolve.length === 0) {
      return;
    }
    setIsSolving(true);
    try {
      const payload = await buildGitHubIssueSelectionPayload({
        cwd,
        issueNumbers: selectedIssueNumbersForSolve,
        queryClient,
      });
      await onFixIssue({ prompt: payload.prompt, images: payload.images });
    } finally {
      setIsSolving(false);
    }
  }, [cwd, isSolving, onFixIssue, queryClient, selectedIssueNumbersForSolve]);

  const errorMessage =
    issuesQuery.isError && issuesQuery.error instanceof Error
      ? issuesQuery.error.message
      : issuesQuery.isError
        ? "Failed to load GitHub issues."
        : null;

  const thread = threadQuery.data?.issue;
  const allVisibleSelected =
    issues.length > 0 && issues.every((issue) => selectedIssueNumberSet.has(issue.number));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSolving) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup
        showCloseButton
        className="flex max-h-[min(46rem,92vh)] min-h-0 max-w-6xl gap-0 overflow-hidden p-0"
      >
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(17rem,30%)_minmax(0,1fr)] overflow-hidden">
          <div className="flex min-h-0 flex-col border-e border-border/60 bg-muted/15 dark:bg-muted/10">
            <div className="shrink-0 border-b border-border/60 px-4 py-3 pe-12">
              <DialogHeader className="gap-0.5 p-0 text-start">
                <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-tight">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-background/90 shadow-sm ring-1 ring-border/50 dark:bg-background/50">
                    <GitHubIcon className="size-4 opacity-90" />
                  </span>
                  GitHub issues
                </DialogTitle>
                <p className="text-muted-foreground text-xs font-normal leading-snug">
                  Browse, filter, and solve one or more issues.
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
                  placeholder="Search title/body"
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

              <div className="flex shrink-0 items-center gap-2 px-1">
                <div className="inline-flex items-center overflow-hidden rounded-md border border-border/60 bg-background/70">
                  {ISSUE_STATE_FILTERS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                        stateFilter === value
                          ? "bg-primary/12 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setStateFilter(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <Select
                  value={String(issueLimit)}
                  onValueChange={(value) => {
                    if (typeof value !== "string") {
                      return;
                    }
                    const parsed = Number.parseInt(value, 10);
                    if (!Number.isInteger(parsed)) {
                      return;
                    }
                    if (
                      !ISSUE_LIMIT_OPTIONS.includes(parsed as (typeof ISSUE_LIMIT_OPTIONS)[number])
                    ) {
                      return;
                    }
                    setIssueLimit(parsed as (typeof ISSUE_LIMIT_OPTIONS)[number]);
                  }}
                >
                  <SelectTrigger className="h-8 min-w-[6.25rem] rounded-md text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {ISSUE_LIMIT_OPTIONS.map((limit) => (
                      <SelectItem key={limit} value={String(limit)} hideIndicator>
                        Show {limit}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

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
                  {issues.length} shown
                </span>
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/40 px-2 py-0.5">
                  <CheckIcon className="size-3 opacity-70" />
                  {selectedIssueNumbersForSolve.length} selected
                </span>
              </div>

              <div className="shrink-0 px-1">
                <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                  <FilterIcon className="size-3.5 opacity-70" />
                  Label filters
                </div>
                <div className="flex flex-wrap gap-1">
                  {availableLabels.length > 0 ? (
                    availableLabels.map(({ label, count }) => {
                      const active = labelFilters.includes(label);
                      return (
                        <button
                          key={label}
                          type="button"
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                            active
                              ? "border-primary/40 bg-primary/12 text-foreground"
                              : "border-border/60 bg-background/70 text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => handleToggleLabelFilter(label)}
                        >
                          {label} · {count}
                        </button>
                      );
                    })
                  ) : (
                    <span className="text-[11px] text-muted-foreground/70">
                      No labels in current results
                    </span>
                  )}
                </div>
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
                      {ISSUE_SKELETON_KEYS.map((skeletonKey) => (
                        <div
                          key={skeletonKey}
                          className="h-[3.5rem] animate-pulse rounded-md bg-muted/45 dark:bg-muted/25"
                        />
                      ))}
                    </div>
                  ) : issues.length === 0 ? (
                    <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                      {trimmedDebouncedSearch.length > 0 || labelFilters.length > 0
                        ? "No issues match your current filters."
                        : "No issues found."}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border/50 bg-background/35 dark:bg-background/20">
                      {issues.map((issue) => {
                        const active = focusedIssue?.number === issue.number;
                        const selected = selectedIssueNumberSet.has(issue.number);
                        return (
                          <div
                            key={issue.number}
                            role="option"
                            aria-selected={active}
                            className={cn(
                              "group flex items-start gap-2 border-b border-border/35 px-2.5 py-2.5 transition-colors last:border-b-0",
                              "hover:bg-muted/50",
                              active &&
                                "bg-primary/[0.08] ring-1 ring-inset ring-primary/25 dark:bg-primary/[0.12]",
                            )}
                          >
                            <Checkbox
                              checked={selected}
                              className="mt-1"
                              onClick={(event) => {
                                event.stopPropagation();
                              }}
                              onCheckedChange={() => handleToggleIssueSelection(issue.number)}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-start"
                              onClick={() => setFocusedIssueNumber(issue.number)}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                {issue.state === "open" ? (
                                  <CircleDotIcon className="size-3.5 shrink-0 text-emerald-500" />
                                ) : (
                                  <CircleXIcon className="size-3.5 shrink-0 text-violet-500" />
                                )}
                                <span className="line-clamp-2 text-[13px] leading-tight font-medium text-foreground">
                                  {issue.title}
                                </span>
                              </div>
                              <div className="mt-1 flex min-w-0 items-center gap-2 ps-[1.1rem]">
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                                  #{issue.number}
                                </span>
                                <span className="truncate text-[11px] text-muted-foreground">
                                  {formatIssueRelativeTime(issue.updatedAt)}
                                </span>
                              </div>
                              {issue.labels.length > 0 ? (
                                <div className="mt-1.5 flex min-w-0 flex-wrap gap-1 ps-[1.1rem]">
                                  {issue.labels.slice(0, 3).map((label) => (
                                    <span
                                      key={label.name}
                                      className="max-w-[7.75rem] truncate rounded-full bg-muted/80 px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                                    >
                                      {label.name}
                                    </span>
                                  ))}
                                  {issue.labels.length > 3 ? (
                                    <span className="text-[10px] text-muted-foreground">
                                      +{issue.labels.length - 3}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col bg-popover">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {focusedIssue ? (
                <>
                  <div className="shrink-0 border-b border-border/60 px-6 pb-4 pt-5 pe-14">
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-start justify-between gap-2 gap-y-1">
                        <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug tracking-tight text-foreground">
                          <span className="text-muted-foreground font-mono text-base font-normal tabular-nums">
                            #{focusedIssue.number}
                          </span>{" "}
                          {focusedIssue.title}
                        </h2>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5 rounded-md"
                          render={<a href={focusedIssue.url} target="_blank" rel="noreferrer" />}
                        >
                          GitHub
                          <ExternalLinkIcon className="size-3.5 opacity-70" />
                        </Button>
                      </div>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <Badge
                          variant={focusedIssue.state === "open" ? "success" : "outline"}
                          size="sm"
                          className="h-5 rounded-full px-2 text-[11px] font-normal capitalize"
                        >
                          {focusedIssue.state}
                        </Badge>
                        <span className="text-border hidden sm:inline">·</span>
                        <span>
                          Opened by{" "}
                          <span className="text-foreground/90 font-medium">
                            {focusedIssue.author?.login ?? "unknown"}
                          </span>
                        </span>
                        <span className="text-border">·</span>
                        <span>{formatIssueRelativeTime(focusedIssue.createdAt)}</span>
                      </div>
                      {focusedIssue.labels.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {focusedIssue.labels.map((label) => (
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
                            <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 dark:bg-muted/10">
                              <ChatMarkdown
                                text={
                                  thread.body?.trim().length
                                    ? thread.body
                                    : "No description provided."
                                }
                                cwd={undefined}
                              />
                            </div>
                          </section>
                          {thread.comments.length > 0 ? (
                            <section>
                              <h3 className="text-foreground/90 mb-3 text-xs font-semibold uppercase tracking-wide">
                                Comments ({thread.comments.length})
                              </h3>
                              <ul className="space-y-3">
                                {thread.comments.map((comment) => (
                                  <li
                                    key={
                                      comment.url ??
                                      `${comment.createdAt}-${comment.author?.login ?? "unknown"}`
                                    }
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
                                    <ChatMarkdown
                                      text={
                                        comment.body?.trim().length
                                          ? comment.body
                                          : "Empty comment."
                                      }
                                      cwd={undefined}
                                    />
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
              <div className="me-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-md text-xs"
                  onClick={() => {
                    if (allVisibleSelected) {
                      setSelectedIssueNumbers((existing) =>
                        existing.filter((issueNumber) => !issueByNumber.has(issueNumber)),
                      );
                      return;
                    }
                    setSelectedIssueNumbers((existing) => {
                      const next = new Set(existing);
                      for (const issue of issues) {
                        next.add(issue.number);
                      }
                      return Array.from(next);
                    });
                  }}
                >
                  {allVisibleSelected ? "Unselect visible" : "Select visible"}
                </Button>
                {selectedIssueNumberSet.size > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="rounded-md text-xs"
                    onClick={() => {
                      setSelectedIssueNumbers([]);
                    }}
                  >
                    Clear selection
                  </Button>
                ) : null}
              </div>
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
                disabled={selectedIssueNumbersForSolve.length === 0 || isSolving}
                className="min-w-[8.5rem] rounded-md"
                onClick={() => {
                  void handleSolveSelectedIssues();
                }}
              >
                {isSolving ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="size-3.5" />
                    Sending…
                  </span>
                ) : selectedIssueNumbersForSolve.length > 1 ? (
                  `Solve ${selectedIssueNumbersForSolve.length} issues`
                ) : (
                  "Solve issue"
                )}
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
