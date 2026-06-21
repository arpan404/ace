import type { GitBranch } from "@ace/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import {
  type CSSProperties,
  useDeferredValue,
  useOptimistic,
  useState,
  useTransition,
} from "react";

import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { withRpcRouteConnection } from "../lib/connectionRouting";
import { reportBackgroundError } from "../lib/async";
import { readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
} from "../lib/git/branchToolbar";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { toastManager } from "./ui/toast";
import {
  DRAFT_CONTEXT_PILL_ICON_CLASS_NAME,
  DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME,
} from "./thread/topBarClusterStyles";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  connectionUrl?: string | null | undefined;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  presentation?: "toolbar" | "environment" | "draft";
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

function BranchToolbarPickerList(props: {
  activeProjectCwd: string;
  branchByName: Map<string, GitBranch>;
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  createBranch: (rawName: string) => void;
  filteredBranchPickerItems: string[];
  onCheckoutPullRequestRequest: ((reference: string) => void) | undefined;
  onComposerFocusRequest: (() => void) | undefined;
  itemClassName?: string;
  prReference: string | null;
  selectBranch: (branch: GitBranch) => void;
  setBranchQuery: (value: string) => void;
  setIsBranchMenuOpen: (open: boolean) => void;
  trimmedBranchQuery: string;
}) {
  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    if (props.checkoutPullRequestItemValue && itemValue === props.checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          className={props.itemClassName}
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => {
            if (!props.prReference || !props.onCheckoutPullRequestRequest) return;
            props.setIsBranchMenuOpen(false);
            props.setBranchQuery("");
            props.onComposerFocusRequest?.();
            props.onCheckoutPullRequestRequest(props.prReference);
          }}
        >
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-muted-foreground text-xs">{props.prReference}</span>
          </div>
        </ComboboxItem>
      );
    }
    if (props.createBranchItemValue && itemValue === props.createBranchItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          className={props.itemClassName}
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => props.createBranch(props.trimmedBranchQuery)}
        >
          <span className="truncate">Create new branch "{props.trimmedBranchQuery}"</span>
        </ComboboxItem>
      );
    }

    const branch = props.branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree =
      branch.worktreePath && branch.worktreePath !== props.activeProjectCwd;
    const badge = branch.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : branch.isRemote
          ? "remote"
          : branch.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        className={props.itemClassName}
        key={itemValue}
        index={index}
        value={itemValue}
        style={style}
        onClick={() => props.selectBranch(branch)}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  return (
    <ComboboxList className="max-h-56">
      {props.filteredBranchPickerItems.map((itemValue, index) =>
        renderPickerItem(itemValue, index),
      )}
    </ComboboxList>
  );
}

function useBranchMutationActions(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  connectionUrl?: string | null | undefined;
  isBranchActionPending: boolean;
  isSelectingWorktreeBase: boolean;
  onComposerFocusRequest: (() => void) | undefined;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  setBranchQuery: (value: string) => void;
  setIsBranchMenuOpen: (open: boolean) => void;
  setOptimisticBranch: (branch: string | null) => void;
  startBranchActionTransition: React.TransitionStartFunction;
}) {
  const runBranchAction = (action: () => Promise<void>) => {
    input.startBranchActionTransition(async () => {
      await action().catch((error) => {
        reportBackgroundError("Failed to run the selected branch action.", error);
      });
      await invalidateGitQueries(input.queryClient).catch((error) => {
        reportBackgroundError("Failed to refresh git queries after the branch action.", error);
      });
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !input.branchCwd || input.isBranchActionPending) return;
    const branchCwd = input.branchCwd;

    if (input.isSelectingWorktreeBase) {
      input.onSetThreadBranch(branch.name, null);
      input.setIsBranchMenuOpen(false);
      input.onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd: input.activeProjectCwd,
      activeWorktreePath: input.activeWorktreePath,
      branch,
    });
    if (selectionTarget.reuseExistingWorktree) {
      input.onSetThreadBranch(branch.name, selectionTarget.nextWorktreePath);
      input.setIsBranchMenuOpen(false);
      input.onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;
    input.setIsBranchMenuOpen(false);
    input.onComposerFocusRequest?.();

    runBranchAction(async () => {
      input.setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({
          ...withRpcRouteConnection(
            {
              cwd: selectionTarget.checkoutCwd,
              branch: branch.name,
            },
            input.connectionUrl,
          ),
        });
        await invalidateGitQueries(input.queryClient);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git
          .status(withRpcRouteConnection({ cwd: branchCwd }, input.connectionUrl))
          .catch(() => null);
        if (status?.branch) nextBranchName = status.branch;
      }
      input.setOptimisticBranch(nextBranchName);
      input.onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !input.branchCwd || !name || input.isBranchActionPending) return;
    const branchCwd = input.branchCwd;

    input.setIsBranchMenuOpen(false);
    input.onComposerFocusRequest?.();

    runBranchAction(async () => {
      input.setOptimisticBranch(name);
      try {
        await api.git.createBranch(
          withRpcRouteConnection({ cwd: branchCwd, branch: name }, input.connectionUrl),
        );
        try {
          await api.git.checkout(
            withRpcRouteConnection({ cwd: branchCwd, branch: name }, input.connectionUrl),
          );
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      input.setOptimisticBranch(name);
      input.onSetThreadBranch(name, input.activeWorktreePath);
      input.setBranchQuery("");
    });
  };

  return { createBranch, selectBranch };
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  connectionUrl,
  effectiveEnvMode,
  envLocked,
  presentation = "toolbar",
  onSetThreadBranch,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const { data: branchesData, isLoading: isBranchesLoading } = useQuery(
    gitBranchesQueryOptions(branchCwd, connectionUrl),
  );
  const { data: branchStatusData } = useQuery(gitStatusQueryOptions(branchCwd, connectionUrl));
  const branches = dedupeRemoteBranchesWithLocalMatches(branchesData?.branches ?? []);
  const currentGitBranch =
    branchStatusData?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchByName = new Map(branches.map((branch) => [branch.name, branch] as const));
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutPullRequestItemValue =
    prReference && onCheckoutPullRequestRequest ? `__checkout_pull_request__:${prReference}` : null;
  const canCreateBranch = !isSelectingWorktreeBase && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const createBranchItemValue = canCreateBranch
    ? `__create_new_branch__:${trimmedBranchQuery}`
    : null;
  const branchPickerItems = (() => {
    const items = branches.map((branch) => branch.name);
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  })();
  const filteredBranchPickerItems =
    normalizedDeferredBranchQuery.length === 0
      ? branchPickerItems
      : branchPickerItems.filter((itemValue) =>
          shouldIncludeBranchPickerItem({
            itemValue,
            normalizedQuery: normalizedDeferredBranchQuery,
            createBranchItemValue,
            checkoutPullRequestItemValue,
          }),
        );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();

  const { createBranch, selectBranch } = useBranchMutationActions({
    activeProjectCwd,
    activeWorktreePath,
    branchCwd,
    connectionUrl,
    isBranchActionPending,
    isSelectingWorktreeBase,
    onComposerFocusRequest,
    onSetThreadBranch,
    queryClient,
    setBranchQuery,
    setIsBranchMenuOpen,
    setOptimisticBranch,
    startBranchActionTransition,
  });

  const handleOpenChange = (open: boolean) => {
    setIsBranchMenuOpen(open);
    if (!open) {
      setBranchQuery("");
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.branches(branchCwd, connectionUrl),
    });
  };

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });
  const isEnvironmentPresentation = presentation === "environment";
  const isDraftPresentation = presentation === "draft";
  const isBranchListLoading = isBranchesLoading && branches.length === 0;

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            size={isEnvironmentPresentation || isDraftPresentation ? "default" : "xs"}
          />
        }
        className={
          isEnvironmentPresentation
            ? "min-h-8 w-full justify-start gap-2 rounded-[var(--control-radius)] px-2 py-1 text-[13px] font-normal text-foreground/82 transition-colors duration-150 hover:bg-black/[0.045] hover:text-foreground dark:hover:bg-white/[0.09]"
            : isDraftPresentation
              ? `${DRAFT_CONTEXT_PILL_TRIGGER_CLASS_NAME} max-w-[16rem] justify-start`
              : "text-muted-foreground/70 hover:text-foreground/80"
        }
        disabled={isBranchListLoading || isBranchActionPending}
      >
        {isEnvironmentPresentation || isDraftPresentation ? (
          isBranchListLoading ? (
            <span className={isDraftPresentation ? DRAFT_CONTEXT_PILL_ICON_CLASS_NAME : undefined}>
              <Spinner className="size-3.5 text-muted-foreground" />
            </span>
          ) : (
            <span className={isDraftPresentation ? DRAFT_CONTEXT_PILL_ICON_CLASS_NAME : undefined}>
              <GitBranchIcon className="size-3.5 text-muted-foreground" />
            </span>
          )
        ) : null}
        <span
          className={
            isEnvironmentPresentation
              ? "min-w-0 flex-1 truncate text-left"
              : isDraftPresentation
                ? "min-w-0 truncate"
                : "max-w-[240px] truncate"
          }
        >
          {isBranchListLoading ? "Loading branches" : triggerLabel}
        </span>
        <ChevronDownIcon
          className={
            isEnvironmentPresentation || isDraftPresentation
              ? "size-3.5 shrink-0 text-muted-foreground/55"
              : undefined
          }
        />
      </ComboboxTrigger>
      <ComboboxPopup
        align={isEnvironmentPresentation || isDraftPresentation ? "start" : "end"}
        side={isEnvironmentPresentation || isDraftPresentation ? "bottom" : "top"}
        sideOffset={isEnvironmentPresentation || isDraftPresentation ? 6 : 4}
        className={
          isEnvironmentPresentation
            ? "glass-surface w-[var(--button-width)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-[var(--panel-radius)] border"
            : isDraftPresentation
              ? "glass-surface w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-[var(--panel-radius)] border"
              : "w-80"
        }
      >
        <div
          className={
            isEnvironmentPresentation || isDraftPresentation
              ? "border-border/45 border-b px-2 pt-2 pb-2"
              : "border-b p-1"
          }
        >
          <ComboboxInput
            className={
              isEnvironmentPresentation || isDraftPresentation
                ? "[&_input]:font-sans rounded-[var(--control-radius)] border-border/50 bg-background/45 text-[13px] has-focus-visible:border-border/70 has-focus-visible:bg-background/65"
                : "[&_input]:font-sans rounded-md"
            }
            inputClassName="ring-0"
            placeholder="Search branches..."
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No branches found.</ComboboxEmpty>

        <BranchToolbarPickerList
          activeProjectCwd={activeProjectCwd}
          branchByName={branchByName}
          checkoutPullRequestItemValue={checkoutPullRequestItemValue}
          createBranch={createBranch}
          createBranchItemValue={createBranchItemValue}
          filteredBranchPickerItems={filteredBranchPickerItems}
          onCheckoutPullRequestRequest={onCheckoutPullRequestRequest}
          onComposerFocusRequest={onComposerFocusRequest}
          prReference={prReference}
          selectBranch={selectBranch}
          setBranchQuery={setBranchQuery}
          setIsBranchMenuOpen={setIsBranchMenuOpen}
          trimmedBranchQuery={trimmedBranchQuery}
          {...(isEnvironmentPresentation
            ? {
                itemClassName:
                  "min-h-9 rounded-[var(--control-radius)] px-2 text-[13px] data-selected:bg-black/[0.045] dark:data-selected:bg-white/[0.09]",
              }
            : isDraftPresentation
              ? {
                  itemClassName:
                    "min-h-9 rounded-[var(--control-radius)] px-2 text-[13px] data-selected:bg-black/[0.045] dark:data-selected:bg-white/[0.09]",
                }
              : {})}
        />
      </ComboboxPopup>
    </Combobox>
  );
}
