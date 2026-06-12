"use client";

import type { GitHubIssue } from "@ace/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  CheckIcon,
  ChevronDownIcon,
  FilterIcon,
  GitBranchPlusIcon,
  ListChecksIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { buildGitHubIssueSelectionPayload } from "~/lib/chat/githubIssueSelection";
import {
  type GitHubIssueListStateFilter,
  gitGitHubIssueThreadQueryOptions,
  gitGitHubIssuesQueryOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { formatIssueRelativeTime } from "./issueTime";
import { GitHubIssueListSkeleton, GitHubIssueThreadSkeleton } from "./GitHubIssueSkeletons";
import {
  GitHubIssueExternalLink,
  GitHubIssueLabelStrip,
  GitHubIssueThreadReader,
  GitHubIssueTitleBlock,
} from "./GitHubIssueSurface";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogFooter, DialogPopup } from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
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
const EMPTY_INITIAL_SELECTED_ISSUE_NUMBERS: readonly number[] = [];
const SOLVE_SPLIT_BUTTON_CLASS_NAME =
  "h-8 bg-primary text-primary-foreground shadow-[0_12px_30px_-20px_color-mix(in_oklch,var(--primary)_85%,transparent),inset_0_1px_0_color-mix(in_oklch,var(--primary-foreground)_26%,transparent)] hover:bg-[color-mix(in_oklch,var(--primary)_88%,var(--foreground)_12%)] focus-visible:ring-primary/35 disabled:shadow-none";

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
  onFixIssuesInParallelWorktrees: (issueNumbers: ReadonlyArray<number>) => void | Promise<void>;
}

type GitHubIssueDialogState = {
  search: string;
  solveAction: "current-thread" | "parallel-worktrees" | null;
  focusedIssueNumber: number | null;
  selectedIssueNumbers: number[];
  stateFilter: GitHubIssueListStateFilter;
  issueLimit: (typeof ISSUE_LIMIT_OPTIONS)[number];
  labelFilters: string[];
};

type GitHubIssueDialogAction =
  | {
      type: "reset";
      initialIssueNumber: number | null;
      initialSelectedIssueNumbers: ReadonlyArray<number>;
    }
  | { type: "set-search"; value: string }
  | { type: "set-solve-action"; value: GitHubIssueDialogState["solveAction"] }
  | { type: "set-focused-issue-number"; value: number | null }
  | { type: "set-selected-issue-numbers"; value: number[] }
  | { type: "toggle-issue-selection"; value: number }
  | { type: "set-state-filter"; value: GitHubIssueListStateFilter }
  | { type: "set-issue-limit"; value: (typeof ISSUE_LIMIT_OPTIONS)[number] }
  | { type: "toggle-label-filter"; value: string }
  | { type: "set-label-filters"; value: string[] };

function createGitHubIssueDialogState(input: {
  initialIssueNumber: number | null;
  initialSelectedIssueNumbers: ReadonlyArray<number>;
}): GitHubIssueDialogState {
  return {
    search: input.initialIssueNumber !== null ? `#${input.initialIssueNumber}` : "",
    solveAction: null,
    focusedIssueNumber: input.initialIssueNumber,
    selectedIssueNumbers: normalizeIssueNumbers(input.initialSelectedIssueNumbers),
    stateFilter: input.initialIssueNumber !== null ? "all" : "open",
    issueLimit: 40,
    labelFilters: [],
  };
}

function gitHubIssueDialogReducer(
  state: GitHubIssueDialogState,
  action: GitHubIssueDialogAction,
): GitHubIssueDialogState {
  switch (action.type) {
    case "reset":
      return createGitHubIssueDialogState({
        initialIssueNumber: action.initialIssueNumber,
        initialSelectedIssueNumbers: action.initialSelectedIssueNumbers,
      });
    case "set-search":
      return { ...state, search: action.value };
    case "set-solve-action":
      return { ...state, solveAction: action.value };
    case "set-focused-issue-number":
      return { ...state, focusedIssueNumber: action.value };
    case "set-selected-issue-numbers":
      return { ...state, selectedIssueNumbers: action.value };
    case "toggle-issue-selection":
      return {
        ...state,
        selectedIssueNumbers: toggleListValue(state.selectedIssueNumbers, action.value),
      };
    case "set-state-filter":
      return { ...state, stateFilter: action.value };
    case "set-issue-limit":
      return { ...state, issueLimit: action.value };
    case "toggle-label-filter":
      return {
        ...state,
        labelFilters: state.labelFilters.includes(action.value)
          ? state.labelFilters.filter((value) => value !== action.value)
          : [...state.labelFilters, action.value],
      };
    case "set-label-filters":
      return { ...state, labelFilters: action.value };
    default:
      return state;
  }
}

function useGitHubIssueDialogComponent({
  open,
  cwd,
  initialIssueNumber = null,
  initialSelectedIssueNumbers = EMPTY_INITIAL_SELECTED_ISSUE_NUMBERS,
  onOpenChange,
  onFixIssue,
  onFixIssuesInParallelWorktrees,
}: GitHubIssueDialogProps) {
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [state, dispatch] = useReducer(
    gitHubIssueDialogReducer,
    {
      initialIssueNumber,
      initialSelectedIssueNumbers,
    },
    createGitHubIssueDialogState,
  );
  const [debouncedSearch, searchDebouncer] = useDebouncedValue(
    state.search,
    { wait: 320 },
    (debounceState) => ({
      isPending: debounceState.isPending,
    }),
  );
  const {
    focusedIssueNumber,
    issueLimit,
    labelFilters,
    search,
    selectedIssueNumbers,
    solveAction,
    stateFilter,
  } = state;
  const isSolving = solveAction !== null;

  useEffect(() => {
    if (!open) {
      return;
    }
    dispatch({
      type: "reset",
      initialIssueNumber,
      initialSelectedIssueNumbers,
    });
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
    const effectiveFocusedIssueNumber = focusedIssueNumber ?? issues[0]?.number ?? null;
    if (effectiveFocusedIssueNumber !== null) {
      return issueByNumber.get(effectiveFocusedIssueNumber) ?? issues[0] ?? null;
    }
    return issues[0] ?? null;
  }, [focusedIssueNumber, issueByNumber, issues]);

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
    dispatch({ type: "toggle-issue-selection", value: issueNumber });
  }, []);

  const handleToggleLabelFilter = useCallback((label: string) => {
    dispatch({ type: "toggle-label-filter", value: label });
  }, []);

  const handleSolveSelectedIssues = useCallback(
    async (action: "current-thread" | "parallel-worktrees") => {
      if (isSolving || selectedIssueNumbersForSolve.length === 0) {
        return;
      }
      dispatch({ type: "set-solve-action", value: action });
      try {
        if (action === "parallel-worktrees") {
          await onFixIssuesInParallelWorktrees(selectedIssueNumbersForSolve);
          return;
        }
        if (!cwd) {
          return;
        }
        const payload = await buildGitHubIssueSelectionPayload({
          cwd,
          issueNumbers: selectedIssueNumbersForSolve,
          queryClient,
        });
        await onFixIssue({ prompt: payload.prompt, images: payload.images });
      } finally {
        dispatch({ type: "set-solve-action", value: null });
      }
    },
    [
      cwd,
      isSolving,
      onFixIssue,
      onFixIssuesInParallelWorktrees,
      queryClient,
      selectedIssueNumbersForSolve,
    ],
  );

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
        className="flex h-[min(38rem,88vh)] min-h-[23rem] max-w-[min(64rem,calc(100vw-1rem))] gap-0 overflow-hidden border-border/50 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--popover)_72%,white_2%),color-mix(in_srgb,var(--popover)_56%,transparent))] p-0 shadow-[0_28px_88px_-44px] shadow-black/70 backdrop-blur-2xl supports-[backdrop-filter]:bg-popover/58"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute end-2.5 top-2.5 z-10 text-muted-foreground/70 hover:bg-foreground/6 hover:text-foreground"
          onClick={() => onOpenChange(false)}
          disabled={isSolving}
          aria-label="Close"
        >
          <XIcon className="size-3.5" />
        </Button>
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(15rem,40%)_minmax(0,1fr)] overflow-hidden md:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)] md:grid-rows-none">
          <aside className="flex min-h-0 flex-col border-b border-border/45 bg-sidebar/42 backdrop-blur-xl md:border-e md:border-b-0">
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-2.5 pt-3">
              <label htmlFor="github-issue-search" className="relative block shrink-0">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
                />
                <Input
                  id="github-issue-search"
                  ref={searchInputRef}
                  placeholder="Search issues…"
                  value={search}
                  onChange={(event) => dispatch({ type: "set-search", value: event.target.value })}
                  className={cn(
                    "h-7 rounded-[var(--control-radius)] border-border/35 bg-background/28 ps-8 text-[12px] shadow-none backdrop-blur-xl",
                    "placeholder:text-muted-foreground/50",
                    "focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/15",
                  )}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") event.stopPropagation();
                  }}
                />
              </label>

              <div className="mt-1 flex shrink-0 flex-wrap items-center gap-2">
                <div className="inline-flex items-center overflow-hidden rounded-[var(--control-radius)] border border-border/35 bg-background/24 backdrop-blur-xl">
                  {ISSUE_STATE_FILTERS.map((value) => (
                    <Button
                      key={value}
                      type="button"
                      variant="ghost"
                      className={cn(
                        "h-6 rounded-none px-2 py-0 text-[11px] font-medium capitalize hover:bg-transparent",
                        stateFilter === value
                          ? "bg-foreground/8 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => dispatch({ type: "set-state-filter", value })}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
                <div className="inline-flex items-center overflow-hidden rounded-[var(--control-radius)] border border-border/35 bg-background/24 backdrop-blur-xl">
                  {ISSUE_LIMIT_OPTIONS.map((limit) => (
                    <Button
                      key={limit}
                      type="button"
                      variant="ghost"
                      className={cn(
                        "h-6 rounded-none px-1.5 py-0 text-[11px] font-medium tabular-nums transition-colors hover:bg-transparent",
                        issueLimit === limit
                          ? "bg-foreground/8 text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => dispatch({ type: "set-issue-limit", value: limit })}
                      aria-label={`Show ${limit} issues`}
                    >
                      {limit}
                    </Button>
                  ))}
                </div>
                <div className="ms-auto flex items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-6 rounded-[var(--control-radius)] px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-foreground/6 hover:text-foreground"
                    onClick={() => {
                      if (allVisibleSelected) {
                        dispatch({
                          type: "set-selected-issue-numbers",
                          value: selectedIssueNumbers.filter((n) => !issueByNumber.has(n)),
                        });
                      } else {
                        const next = new Set(selectedIssueNumbers);
                        for (const issue of issues) {
                          next.add(issue.number);
                        }
                        dispatch({
                          type: "set-selected-issue-numbers",
                          value: Array.from(next),
                        });
                      }
                    }}
                  >
                    {allVisibleSelected ? "Deselect" : "Select all"}
                  </Button>
                  {selectedIssueNumberSet.size > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-6 rounded-[var(--control-radius)] px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-foreground/6 hover:text-foreground"
                      onClick={() => dispatch({ type: "set-selected-issue-numbers", value: [] })}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="mt-0.5 flex shrink-0 items-center gap-1.5 border-b border-border/30 pb-2 text-[11px] text-muted-foreground/70">
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

              {availableLabels.length > 0 ? (
                <div className="shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    className="mb-1 flex h-auto items-center gap-1 p-0 text-[11px] text-muted-foreground/75 hover:bg-transparent"
                    onClick={() =>
                      dispatch({
                        type: "set-label-filters",
                        value: labelFilters.length > 0 ? [] : labelFilters,
                      })
                    }
                  >
                    <FilterIcon className="size-3 opacity-60" />
                    Labels
                  </Button>
                  <div className="max-h-12 overflow-y-auto">
                    <div className="flex flex-wrap gap-0.5">
                      {availableLabels.map(({ label, count }) => {
                        const active = labelFilters.includes(label);
                        return (
                          <Button
                            key={label}
                            type="button"
                            variant="ghost"
                            className={cn(
                              "h-5 rounded-[.25rem] border px-1.5 py-0 text-[10px] font-medium hover:bg-transparent",
                              active
                                ? "border-border/45 bg-foreground/8 text-foreground"
                                : "border-border/30 bg-background/22 text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => handleToggleLabelFilter(label)}
                          >
                            {label}
                            <span className="ml-0.5 opacity-50">{count}</span>
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}

              {errorMessage ? (
                <div className="shrink-0 rounded-[var(--control-radius)] border border-destructive/20 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive-foreground">
                  {errorMessage}
                </div>
              ) : null}

              <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
                <div aria-label="Issues" className="pb-1">
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
                            aria-selected={active}
                            className={cn(
                              "group flex items-start gap-2 rounded-[var(--control-radius)] border border-transparent px-2 py-2 transition-colors",
                              "hover:bg-foreground/[0.035] dark:hover:bg-foreground/[0.04]",
                              active &&
                                "border-border/45 bg-background/38 shadow-[0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)] backdrop-blur-xl dark:bg-background/20",
                            )}
                          >
                            <Checkbox
                              checked={selected}
                              className="mt-0.5 size-3.5 opacity-75 [&_[data-slot=checkbox-indicator][data-checked]]:border-foreground/85 [&_[data-slot=checkbox-indicator][data-checked]]:bg-foreground/85 [&_[data-slot=checkbox-indicator][data-checked]]:text-background"
                              onClick={(event) => event.stopPropagation()}
                              onCheckedChange={() => handleToggleIssueSelection(issue.number)}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              className="block h-auto min-w-0 flex-1 p-0 text-start font-normal hover:bg-transparent"
                              onClick={() =>
                                dispatch({
                                  type: "set-focused-issue-number",
                                  value: issue.number,
                                })
                              }
                            >
                              <div className="flex min-w-0 items-center">
                                <span className="line-clamp-1 text-[12px] font-medium leading-snug text-foreground/88">
                                  {issue.title}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-1.5">
                                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                                  #{issue.number}
                                </span>
                                <span className="text-[10px] text-muted-foreground/35">·</span>
                                <span className="text-[10px] capitalize text-muted-foreground/55">
                                  {issue.state}
                                </span>
                                <span className="text-[10px] text-muted-foreground/35">·</span>
                                <span className="truncate text-[10px] text-muted-foreground/60">
                                  {formatIssueRelativeTime(issue.updatedAt)}
                                </span>
                              </div>
                              {issue.labels.length > 0 ? (
                                <GitHubIssueLabelStrip
                                  labels={issue.labels}
                                  limit={2}
                                  className="mt-1"
                                />
                              ) : null}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col bg-background/38 backdrop-blur-xl">
            {focusedIssue ? (
              <>
                <div className="shrink-0 border-b border-border/40 bg-background/18 px-5 py-4 backdrop-blur-xl sm:px-6">
                  <GitHubIssueTitleBlock
                    issue={focusedIssue}
                    action={<GitHubIssueExternalLink url={focusedIssue.url} />}
                    actionClassName="me-10 mt-0.5"
                  />
                </div>

                <ScrollArea className="min-h-0 flex-1" scrollbarGutter scrollFade>
                  <div className="max-w-[50rem] px-5 py-4 sm:px-6">
                    {threadQuery.isFetching && !thread ? (
                      <GitHubIssueThreadSkeleton className="py-1" />
                    ) : thread ? (
                      <GitHubIssueThreadReader thread={thread} cwd={cwd} />
                    ) : (
                      <p className="py-12 text-center text-xs text-muted-foreground">
                        Could not load this issue.
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6">
                <div className="max-w-xs text-center">
                  <ListChecksIcon className="mx-auto mb-3 size-8 text-muted-foreground/45" />
                  <p className="text-sm font-medium text-foreground">No issue selected</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Choose an issue from the list to inspect the full thread.
                  </p>
                </div>
              </div>
            )}

            <DialogFooter className="shrink-0 items-center border-t border-border/40 bg-background/22 px-4 py-2.5 backdrop-blur-xl sm:px-5">
              <span className="w-full min-w-0 text-center text-[11px] text-muted-foreground sm:me-auto sm:w-auto sm:text-left">
                {selectedIssueNumbersForSolve.length > 1
                  ? `${selectedIssueNumbersForSolve.length} issues selected`
                  : selectedIssueNumbersForSolve.length === 1
                    ? "1 issue selected"
                    : "Select an issue to solve"}
              </span>
              <div className="flex w-full items-center justify-end sm:w-auto">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={selectedIssueNumbersForSolve.length === 0 || isSolving}
                  className={cn(
                    SOLVE_SPLIT_BUTTON_CLASS_NAME,
                    "min-w-0 flex-1 rounded-l-[var(--control-radius)] rounded-r-none border-r-0 px-3 text-[12px] sm:min-w-[8rem] sm:flex-none",
                  )}
                  onClick={() => void handleSolveSelectedIssues("current-thread")}
                >
                  {isSolving ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner className="size-3" />
                      {solveAction === "parallel-worktrees" ? "Starting…" : "Solving…"}
                    </span>
                  ) : selectedIssueNumbersForSolve.length > 1 ? (
                    `Solve ${selectedIssueNumbersForSolve.length} issues`
                  ) : (
                    "Solve issue"
                  )}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="sm"
                        variant="default"
                        className={cn(
                          SOLVE_SPLIT_BUTTON_CLASS_NAME,
                          "rounded-l-none rounded-r-[var(--control-radius)] border-l border-[color:color-mix(in_oklch,var(--primary-foreground)_24%,transparent)] px-2",
                        )}
                        aria-label="Issue solve actions"
                        disabled={selectedIssueNumbersForSolve.length === 0 || isSolving}
                      />
                    }
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="top" className="min-w-56">
                    <MenuItem
                      className="gap-2 py-1.5 text-[12px]"
                      disabled={selectedIssueNumbersForSolve.length === 0 || isSolving}
                      onClick={() => void handleSolveSelectedIssues("parallel-worktrees")}
                    >
                      <GitBranchPlusIcon className="size-3.5 text-primary" />
                      {selectedIssueNumbersForSolve.length > 1
                        ? "Solve each issue in parallel worktrees"
                        : "Solve in a new worktree thread"}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            </DialogFooter>
          </section>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function GitHubIssueDialog(props: GitHubIssueDialogProps) {
  return useGitHubIssueDialogComponent(props);
}
