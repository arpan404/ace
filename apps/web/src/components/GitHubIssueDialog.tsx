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
import { GitHubIcon } from "./Icons";
import { IssueMarkdown, formatIssueRelativeTime } from "./IssueMarkdown";
import { GitHubIssueListSkeleton, GitHubIssueThreadSkeleton } from "./GitHubIssueSkeletons";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
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
const ISSUE_STATE_FILTERS: ReadonlyArray<GitHubIssueListStateFilter> = ["open", "all"];
const ISSUE_LIMIT_OPTIONS = [40, 80, 120] as const;

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
  const [issueLimit, setIssueLimit] = useState<(typeof ISSUE_LIMIT_OPTIONS)[number]>(40);
  const [labelFilters, setLabelFilters] = useState<string[]>([]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSearch(initialIssueNumber !== null ? `#${initialIssueNumber}` : "");
    setIsSolving(false);
    setStateFilter(initialIssueNumber !== null ? "all" : "open");
    setIssueLimit(40);
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
        showCloseButton={false}
        className="flex h-[min(42rem,92vh)] min-h-[24rem] max-w-[min(72rem,calc(100vw-1rem))] gap-0 overflow-hidden p-0"
      >
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(15rem,40%)_minmax(0,1fr)] overflow-hidden md:grid-cols-[minmax(15rem,28%)_minmax(0,1fr)] md:grid-rows-none">
          {/* ── Left sidebar: issue list ── */}
          <div className="flex min-h-0 flex-col border-b border-border/60 bg-muted/10 dark:bg-muted/5 md:border-e md:border-b-0">
            <div className="shrink-0 border-b border-border/60 px-3.5 py-3 sm:px-4">
              <DialogHeader className="gap-0.5 p-0 text-start">
                <DialogTitle className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <GitHubIcon className="size-4 opacity-80" />
                  GitHub Issues
                </DialogTitle>
              </DialogHeader>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-3 pb-2 pt-2 sm:px-3.5">
              {/* Search */}
              <label className="relative block shrink-0">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
                />
                <Input
                  ref={searchInputRef}
                  placeholder="Search issues…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className={cn(
                    "h-8 rounded-[var(--control-radius)] border-border/55 bg-card/72 ps-8 text-xs shadow-none",
                    "placeholder:text-muted-foreground/50",
                    "focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/15",
                  )}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.stopPropagation();
                  }}
                />
              </label>

              {/* Filters row */}
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <div className="inline-flex items-center overflow-hidden rounded-[var(--control-radius)] border border-border/50 bg-background/60">
                  {ISSUE_STATE_FILTERS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "px-2 py-0.5 text-[10px] font-medium capitalize transition-colors",
                        stateFilter === value
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setStateFilter(value)}
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <div className="inline-flex items-center overflow-hidden rounded-[var(--control-radius)] border border-border/50 bg-background/60">
                  {ISSUE_LIMIT_OPTIONS.map((limit) => (
                    <button
                      key={limit}
                      type="button"
                      className={cn(
                        "px-1.5 py-0.5 text-[10px] font-medium tabular-nums transition-colors",
                        issueLimit === limit
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setIssueLimit(limit)}
                      aria-label={`Show ${limit} issues`}
                    >
                      {limit}
                    </button>
                  ))}
                </div>
                <div className="ms-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    className="rounded-[var(--chip-radius)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                    onClick={() => {
                      if (allVisibleSelected) {
                        setSelectedIssueNumbers((existing) =>
                          existing.filter((n) => !issueByNumber.has(n)),
                        );
                      } else {
                        setSelectedIssueNumbers((existing) => {
                          const next = new Set(existing);
                          for (const issue of issues) next.add(issue.number);
                          return Array.from(next);
                        });
                      }
                    }}
                  >
                    {allVisibleSelected ? "Deselect" : "Select all"}
                  </button>
                  {selectedIssueNumberSet.size > 0 ? (
                    <button
                      type="button"
                      className="rounded-[var(--chip-radius)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                      onClick={() => setSelectedIssueNumbers([])}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Status bar */}
              <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-medium tabular-nums",
                    isSearchStale && "opacity-50",
                  )}
                >
                  {issuesQuery.isFetching && !issuesQuery.isPending ? (
                    <Spinner className="size-2.5" />
                  ) : null}
                  {issues.length} shown
                </span>
                {selectedIssueNumbersForSolve.length > 0 ? (
                  <>
                    <span className="text-border">·</span>
                    <span className="inline-flex items-center gap-0.5 tabular-nums">
                      <CheckIcon className="size-2.5 opacity-60" />
                      {selectedIssueNumbersForSolve.length} selected
                    </span>
                  </>
                ) : null}
              </div>

              {/* Label filters */}
              {availableLabels.length > 0 ? (
                <div className="shrink-0">
                  <button
                    type="button"
                    className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground/80"
                    onClick={() => setLabelFilters((f) => (f.length > 0 ? [] : f))}
                  >
                    <FilterIcon className="size-3 opacity-60" />
                    Labels
                  </button>
                  <div className="max-h-12 overflow-y-auto">
                    <div className="flex flex-wrap gap-0.5">
                      {availableLabels.map(({ label, count }) => {
                        const active = labelFilters.includes(label);
                        return (
                          <button
                            key={label}
                            type="button"
                            className={cn(
                              "rounded-[var(--chip-radius)] border px-1.5 py-px text-[9px] font-medium transition-colors",
                              active
                                ? "border-primary/30 bg-primary/10 text-foreground"
                                : "border-border/40 bg-background/50 text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => handleToggleLabelFilter(label)}
                          >
                            {label}
                            <span className="ml-0.5 opacity-50">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}

              {errorMessage ? (
                <div className="shrink-0 rounded-[var(--control-radius)] border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
                  {errorMessage}
                </div>
              ) : null}

              {/* Issue list */}
              <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
                <div role="listbox" aria-label="Issues">
                  {issuesQuery.isPending && issues.length === 0 ? (
                    <GitHubIssueListSkeleton count={ISSUE_SKELETON_KEYS.length} />
                  ) : issues.length === 0 ? (
                    <p className="py-10 text-center text-xs text-muted-foreground">
                      {trimmedDebouncedSearch.length > 0 || labelFilters.length > 0
                        ? "No matching issues."
                        : "No issues found."}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-px">
                      {issues.map((issue) => {
                        const active = focusedIssue?.number === issue.number;
                        const selected = selectedIssueNumberSet.has(issue.number);
                        return (
                          <div
                            key={issue.number}
                            role="option"
                            aria-selected={active}
                            className={cn(
                              "group flex items-start gap-2 rounded-[var(--control-radius)] border border-transparent px-2 py-2 transition-colors",
                              "hover:border-border/35 hover:bg-muted/30 dark:hover:border-border/25 dark:hover:bg-muted/15",
                              active &&
                                "border-border/50 bg-muted/34 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.18)] dark:border-border/40 dark:bg-muted/20",
                            )}
                          >
                            <Checkbox
                              checked={selected}
                              className="mt-0.5 size-3.5"
                              onClick={(event) => event.stopPropagation()}
                              onCheckedChange={() => handleToggleIssueSelection(issue.number)}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-start"
                              onClick={() => setFocusedIssueNumber(issue.number)}
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                {issue.state === "open" ? (
                                  <CircleDotIcon className="size-3 shrink-0 text-emerald-500" />
                                ) : (
                                  <CircleXIcon className="size-3 shrink-0 text-violet-500" />
                                )}
                                <span className="line-clamp-2 text-xs font-medium leading-snug text-foreground">
                                  {issue.title}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5 ps-[1.125rem]">
                                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                                  #{issue.number}
                                </span>
                                <span className="truncate text-[10px] text-muted-foreground/60">
                                  {formatIssueRelativeTime(issue.updatedAt)}
                                </span>
                              </div>
                              {issue.labels.length > 0 ? (
                                <div className="mt-1 flex flex-wrap gap-0.5 ps-[1.125rem]">
                                  {issue.labels.slice(0, 3).map((label) => (
                                    <span
                                      key={label.name}
                                      className="max-w-[7rem] truncate rounded-[var(--chip-radius)] bg-muted/60 px-1.5 py-px text-[9px] font-medium text-muted-foreground dark:bg-muted/30"
                                    >
                                      {label.name}
                                    </span>
                                  ))}
                                  {issue.labels.length > 3 ? (
                                    <span className="text-[9px] text-muted-foreground/60">
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

          {/* ── Right panel: issue detail ── */}
          <div className="flex min-h-0 min-w-0 flex-col bg-popover md:bg-popover">
            {focusedIssue ? (
              <>
                {/* Issue header */}
                <div className="shrink-0 border-b border-border/50 px-4 py-3 sm:px-6 sm:py-4">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug tracking-tight text-foreground">
                      <span className="font-mono text-sm font-normal text-muted-foreground/70 tabular-nums">
                        #{focusedIssue.number}
                      </span>{" "}
                      {focusedIssue.title}
                    </h2>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5 text-xs"
                      render={<a href={focusedIssue.url} target="_blank" rel="noreferrer" />}
                    >
                      GitHub
                      <ExternalLinkIcon className="size-3 opacity-60" />
                    </Button>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Badge
                      variant={focusedIssue.state === "open" ? "success" : "outline"}
                      size="sm"
                      className="h-[18px] rounded-[var(--chip-radius)] px-1.5 text-[10px] font-medium capitalize"
                    >
                      {focusedIssue.state}
                    </Badge>
                    <span>
                      Opened by{" "}
                      <span className="font-medium text-foreground/90">
                        {focusedIssue.author?.login ?? "unknown"}
                      </span>
                    </span>
                    <span className="text-border/60">·</span>
                    <span>{formatIssueRelativeTime(focusedIssue.createdAt)}</span>
                    {focusedIssue.labels.length > 0 ? (
                      <>
                        <span className="text-border/60">·</span>
                        {focusedIssue.labels.map((label) => (
                          <Badge
                            key={label.name}
                            variant="secondary"
                            size="sm"
                            className="h-[18px] rounded-[var(--chip-radius)] px-1.5 text-[10px] font-normal"
                          >
                            {label.name}
                          </Badge>
                        ))}
                      </>
                    ) : null}
                  </div>
                </div>

                {/* Issue body + comments */}
                <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
                  <div className="px-4 py-4 sm:px-6 sm:py-5">
                    {threadQuery.isFetching && !thread ? (
                      <GitHubIssueThreadSkeleton className="py-1" />
                    ) : thread ? (
                      <div className="space-y-5">
                        {/* Description */}
                        <div className="rounded-[var(--control-radius)] border border-border/40 bg-muted/10 px-4 py-3 dark:bg-muted/5">
                          <IssueMarkdown
                            text={
                              thread.body?.trim().length ? thread.body : "No description provided."
                            }
                            cwd={cwd}
                          />
                        </div>

                        {/* Comments */}
                        {thread.comments.length > 0 ? (
                          <div>
                            <h3 className="mb-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                              Comments ({thread.comments.length})
                            </h3>
                            <div className="space-y-2">
                              {thread.comments.map((comment) => (
                                <div
                                  key={
                                    comment.url ??
                                    `${comment.createdAt}-${comment.author?.login ?? "unknown"}`
                                  }
                                  className="rounded-[var(--control-radius)] border border-border/35 bg-background/50 px-4 py-3 dark:bg-background/20"
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
                                    text={
                                      comment.body?.trim().length ? comment.body : "Empty comment."
                                    }
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
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-xs text-muted-foreground">Select an issue from the list</p>
              </div>
            )}

            {/* Footer */}
            <DialogFooter className="shrink-0 border-t border-border/50 bg-muted/10 px-4 py-2.5 dark:bg-muted/5 sm:px-6 sm:py-2.5">
              <span className="w-full text-center text-[11px] text-muted-foreground sm:me-auto sm:w-auto sm:text-left">
                {selectedIssueNumbersForSolve.length > 1
                  ? `${selectedIssueNumbersForSolve.length} issues selected`
                  : selectedIssueNumbersForSolve.length === 1
                    ? "1 issue selected"
                    : "Select an issue to solve"}
              </span>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={selectedIssueNumbersForSolve.length === 0 || isSolving}
                className="w-full min-w-[7.5rem] text-xs sm:w-auto"
                onClick={() => void handleSolveSelectedIssues()}
              >
                {isSolving ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="size-3" />
                    Solving…
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
