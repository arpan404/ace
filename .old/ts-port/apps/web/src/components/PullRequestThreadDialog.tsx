import type { GitResolvePullRequestResult } from "@ace/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useEffect, useReducer, useRef } from "react";

import {
  gitPreparePullRequestThreadMutationOptions,
  gitResolvePullRequestQueryOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface PullRequestThreadDialogProps {
  open: boolean;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

type PullRequestThreadDialogState = {
  reference: string;
  referenceDirty: boolean;
  preparingMode: "local" | "worktree" | null;
};

type PullRequestThreadDialogAction =
  | { type: "reset"; initialReference: string | null }
  | { type: "set-reference"; value: string }
  | { type: "set-reference-dirty"; value: boolean }
  | { type: "set-preparing-mode"; value: "local" | "worktree" | null };

function createPullRequestThreadDialogState(initialReference: string | null) {
  return {
    reference: initialReference ?? "",
    referenceDirty: false,
    preparingMode: null,
  } satisfies PullRequestThreadDialogState;
}

function pullRequestThreadDialogReducer(
  state: PullRequestThreadDialogState,
  action: PullRequestThreadDialogAction,
): PullRequestThreadDialogState {
  switch (action.type) {
    case "reset":
      return createPullRequestThreadDialogState(action.initialReference);
    case "set-reference":
      return { ...state, reference: action.value };
    case "set-reference-dirty":
      return { ...state, referenceDirty: action.value };
    case "set-preparing-mode":
      return { ...state, preparingMode: action.value };
    default:
      return state;
  }
}

function pullRequestStatusTone(state: string | null | undefined) {
  switch (state) {
    case "merged":
      return "text-violet-600 dark:text-violet-300/90";
    case "closed":
      return "text-zinc-500 dark:text-zinc-400/80";
    case "open":
      return "text-emerald-600 dark:text-emerald-300/90";
    default:
      return "text-muted-foreground";
  }
}

export function PullRequestThreadDialog({
  open,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const queryClient = useQueryClient();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [state, dispatch] = useReducer(
    pullRequestThreadDialogReducer,
    initialReference,
    createPullRequestThreadDialogState,
  );
  const { preparingMode, reference, referenceDirty } = state;
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );

  useEffect(() => {
    if (!open) return;
    dispatch({ type: "reset", initialReference });
  }, [initialReference, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const {
    data: resolvePullRequestData,
    error: resolvePullRequestError,
    isError: isResolvePullRequestError,
    isFetching: isResolvePullRequestFetching,
    isPending: isResolvePullRequestPending,
  } = useQuery(
    gitResolvePullRequestQueryOptions({
      cwd,
      reference: open ? parsedDebouncedReference : null,
    }),
  );
  const cachedPullRequest =
    cwd && parsedReference
      ? (queryClient.getQueryData<GitResolvePullRequestResult>([
          "git",
          "pull-request",
          cwd,
          parsedReference,
        ])?.pullRequest ?? null)
      : null;
  const preparePullRequestThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({ cwd, queryClient }),
  );

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (resolvePullRequestData?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      isResolvePullRequestPending ||
      isResolvePullRequestFetching);
  const statusTone = pullRequestStatusTone(resolvedPullRequest?.state);

  const handleConfirm = async (mode: "local" | "worktree") => {
    if (!parsedReference) {
      dispatch({ type: "set-reference-dirty", value: true });
      return;
    }
    if (!parsedReference || !resolvedPullRequest || !cwd) {
      return;
    }
    dispatch({ type: "set-preparing-mode", value: mode });
    try {
      const result = await preparePullRequestThreadMutation.mutateAsync({
        reference: parsedReference,
        mode,
      });
      await onPrepared({
        branch: result.branch,
        worktreePath: result.worktreePath,
      });
      onOpenChange(false);
    } catch (error) {
      dispatch({ type: "set-preparing-mode", value: null });
      throw error;
    }
    dispatch({ type: "set-preparing-mode", value: null });
  };

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a GitHub pull request URL, `gh pr checkout 123`, or enter 123 / #123."
      : parsedReference === null
        ? "Use a GitHub pull request URL, `gh pr checkout 123`, 123, or #123."
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && isResolvePullRequestError
      ? resolvePullRequestError instanceof Error
        ? resolvePullRequestError.message
        : "Failed to resolve pull request."
      : preparePullRequestThreadMutation.error instanceof Error
        ? preparePullRequestThreadMutation.error.message
        : preparePullRequestThreadMutation.error
          ? "Failed to prepare pull request thread."
          : null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparePullRequestThreadMutation.isPending) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Checkout Pull Request</DialogTitle>
          <DialogDescription>
            Resolve a GitHub pull request, then create the draft thread in the main repo or in a
            dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label htmlFor="pull-request-reference" className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Pull request</span>
            <Input
              id="pull-request-reference"
              ref={referenceInputRef}
              placeholder="https://github.com/owner/repo/pull/42, gh pr checkout 42, or #42"
              value={reference}
              onChange={(event) => {
                dispatch({ type: "set-reference-dirty", value: true });
                dispatch({ type: "set-reference", value: event.target.value });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !preparePullRequestThreadMutation.isPending) {
                  void handleConfirm("local");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-[var(--panel-radius)] border border-border/70 bg-muted/18 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Resolving pull request…
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={preparePullRequestThreadMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleConfirm("local");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadMutation.isPending
            }
          >
            {preparingMode === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={
              !cwd ||
              !resolvedPullRequest ||
              isResolving ||
              preparePullRequestThreadMutation.isPending
            }
          >
            {preparingMode === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
