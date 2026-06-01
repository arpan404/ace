import type { GitBranch } from "@ace/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, GitForkIcon } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
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

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  presentation?: "toolbar" | "environment";
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
  branchListVirtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  checkoutPullRequestItemValue: string | null;
  createBranchItemValue: string | null;
  createBranch: (rawName: string) => void;
  filteredBranchPickerItems: string[];
  onCheckoutPullRequestRequest: ((reference: string) => void) | undefined;
  onComposerFocusRequest: (() => void) | undefined;
  itemClassName?: string;
  prReference: string | null;
  selectBranch: (branch: GitBranch) => void;
  setBranchListRef: (element: HTMLDivElement | null) => void;
  setBranchQuery: (value: string) => void;
  setIsBranchMenuOpen: (open: boolean) => void;
  shouldVirtualizeBranchList: boolean;
  trimmedBranchQuery: string;
  virtualBranchRows: ReturnType<
    typeof useVirtualizer<HTMLDivElement, Element>
  >["getVirtualItems"] extends () => infer T
    ? T
    : never;
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
    <ComboboxList ref={props.setBranchListRef} className="max-h-56">
      {props.shouldVirtualizeBranchList ? (
        <div
          className="relative"
          style={{
            height: `${props.branchListVirtualizer.getTotalSize()}px`,
          }}
        >
          {props.virtualBranchRows.map((virtualRow) => {
            const itemValue = props.filteredBranchPickerItems[virtualRow.index];
            if (!itemValue) return null;
            return renderPickerItem(itemValue, virtualRow.index, {
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            });
          })}
        </div>
      ) : (
        props.filteredBranchPickerItems.map((itemValue, index) =>
          renderPickerItem(itemValue, index),
        )
      )}
    </ComboboxList>
  );
}

function useBranchMutationActions(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  branchCwd: string | null;
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
  const runBranchAction = useCallback(
    (action: () => Promise<void>) => {
      input.startBranchActionTransition(async () => {
        await action().catch((error) => {
          reportBackgroundError("Failed to run the selected branch action.", error);
        });
        await invalidateGitQueries(input.queryClient).catch((error) => {
          reportBackgroundError("Failed to refresh git queries after the branch action.", error);
        });
      });
    },
    [input],
  );

  const selectBranch = useCallback(
    (branch: GitBranch) => {
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
            cwd: selectionTarget.checkoutCwd,
            branch: branch.name,
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
          const status = await api.git.status({ cwd: branchCwd }).catch(() => null);
          if (status?.branch) nextBranchName = status.branch;
        }
        input.setOptimisticBranch(nextBranchName);
        input.onSetThreadBranch(nextBranchName, selectionTarget.nextWorktreePath);
      });
    },
    [input, runBranchAction],
  );

  const createBranch = useCallback(
    (rawName: string) => {
      const name = rawName.trim();
      const api = readNativeApi();
      if (!api || !input.branchCwd || !name || input.isBranchActionPending) return;
      const branchCwd = input.branchCwd;

      input.setIsBranchMenuOpen(false);
      input.onComposerFocusRequest?.();

      runBranchAction(async () => {
        input.setOptimisticBranch(name);
        try {
          await api.git.createBranch({ cwd: branchCwd, branch: name });
          try {
            await api.git.checkout({ cwd: branchCwd, branch: name });
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
    },
    [input, runBranchAction],
  );

  return { createBranch, selectBranch };
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
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

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const currentGitBranch =
    branchStatusQuery.data?.branch ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
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
  const branchPickerItems = useMemo(() => {
    const items = [...branchNames];
    if (createBranchItemValue && !hasExactBranchMatch) {
      items.push(createBranchItemValue);
    }
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, createBranchItemValue, hasExactBranchMatch]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) =>
            shouldIncludeBranchPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredBranchQuery,
              createBranchItemValue,
              checkoutPullRequestItemValue,
            }),
          ),
    [
      branchPickerItems,
      checkoutPullRequestItemValue,
      createBranchItemValue,
      normalizedDeferredBranchQuery,
    ],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;

  const { createBranch, selectBranch } = useBranchMutationActions({
    activeProjectCwd,
    activeWorktreePath,
    branchCwd,
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

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(branchCwd),
      });
    },
    [branchCwd, queryClient],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const branchListVirtualizer = useVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: (index) =>
      filteredBranchPickerItems[index] === checkoutPullRequestItemValue ? 44 : 28,
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
    initialRect: {
      height: 224,
      width: 0,
    },
  });
  const virtualBranchRows = branchListVirtualizer.getVirtualItems();
  const setBranchListRef = useCallback(
    (element: HTMLDivElement | null) => {
      branchListScrollElementRef.current =
        (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [
    branchListVirtualizer,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });
  const isEnvironmentPresentation = presentation === "environment";

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, {
          align: "auto",
        });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size={isEnvironmentPresentation ? "default" : "xs"} />}
        className={
          isEnvironmentPresentation
            ? "min-h-9 w-full justify-start gap-3 rounded-lg px-2 py-1.5 text-[15px] font-normal text-foreground hover:bg-accent hover:text-accent-foreground"
            : "text-muted-foreground/70 hover:text-foreground/80"
        }
        disabled={(branchesQuery.isLoading && branches.length === 0) || isBranchActionPending}
      >
        {isEnvironmentPresentation ? (
          <GitForkIcon className="size-4 text-muted-foreground" />
        ) : null}
        <span
          className={
            isEnvironmentPresentation
              ? "min-w-0 flex-1 truncate text-left"
              : "max-w-[240px] truncate"
          }
        >
          {triggerLabel}
        </span>
        <ChevronDownIcon
          className={isEnvironmentPresentation ? "size-4 text-muted-foreground" : undefined}
        />
      </ComboboxTrigger>
      <ComboboxPopup
        align={isEnvironmentPresentation ? "start" : "end"}
        side={isEnvironmentPresentation ? "left" : "top"}
        sideOffset={isEnvironmentPresentation ? 12 : 4}
        className={
          isEnvironmentPresentation
            ? "w-80 overflow-hidden rounded-2xl border-border/70 bg-popover/96 shadow-2xl shadow-black/25 supports-[backdrop-filter]:bg-popover/88 supports-[backdrop-filter]:backdrop-blur-xl"
            : "w-80"
        }
      >
        <div
          className={
            isEnvironmentPresentation ? "border-border/45 border-b px-2 pt-2 pb-2" : "border-b p-1"
          }
        >
          <ComboboxInput
            className={
              isEnvironmentPresentation
                ? "[&_input]:font-sans rounded-xl border-border/50 bg-background/45 text-[15px] has-focus-visible:border-border/70 has-focus-visible:bg-background/65"
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
          branchListVirtualizer={branchListVirtualizer}
          checkoutPullRequestItemValue={checkoutPullRequestItemValue}
          createBranch={createBranch}
          createBranchItemValue={createBranchItemValue}
          filteredBranchPickerItems={filteredBranchPickerItems}
          onCheckoutPullRequestRequest={onCheckoutPullRequestRequest}
          onComposerFocusRequest={onComposerFocusRequest}
          prReference={prReference}
          selectBranch={selectBranch}
          setBranchListRef={setBranchListRef}
          setBranchQuery={setBranchQuery}
          setIsBranchMenuOpen={setIsBranchMenuOpen}
          shouldVirtualizeBranchList={shouldVirtualizeBranchList}
          trimmedBranchQuery={trimmedBranchQuery}
          virtualBranchRows={virtualBranchRows}
          {...(isEnvironmentPresentation
            ? { itemClassName: "min-h-10 rounded-xl px-2 text-[15px] data-selected:bg-accent/45" }
            : {})}
        />
      </ComboboxPopup>
    </Combobox>
  );
}
