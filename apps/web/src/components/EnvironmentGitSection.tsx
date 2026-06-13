import type {
  GitActionProgressEvent,
  GitListBranchesResult,
  GitRunStackedActionResult,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@ace/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  KeyRoundIcon,
  RefreshCwIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";
import { runAsyncTask } from "../lib/async";
import { useEffectEvent } from "../hooks/useEffectEvent";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "../lib/git/actions";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME,
  HEADER_ACTION_DIALOG_HEADER_CLASS_NAME,
  HEADER_ACTION_DIALOG_PANEL_CLASS_NAME,
  HEADER_ACTION_DIALOG_POPUP_CLASS_NAME,
  HEADER_ACTION_FIELD_CARD_CLASS_NAME,
  HEADER_ACTION_FIELD_CONTROL_CLASS_NAME,
  HEADER_ACTION_FIELD_LABEL_CLASS_NAME,
} from "~/components/thread/topBarClusterStyles";
import {
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { resolveEditorInstanceStateScopeId, useEditorStateStore } from "~/editorStateStore";
import type { ThreadWorkspaceMode } from "~/threadWorkspaceMode";
import { useSettings } from "~/hooks/useSettings";
import { applySettingsUpdated } from "~/rpc/serverState";

interface EnvironmentGitSectionProps {
  connectionUrl?: string | null;
  editorStateInstanceId?: string | null;
  gitCwd: string | null;
  gitStatus: GitStatusResult | null;
  gitStatusError: Error | null;
  branchList: GitListBranchesResult | null;
  activeThreadId: ThreadId | null;
  workspaceMode: ThreadWorkspaceMode;
  onWorkspaceModeChange: (mode: ThreadWorkspaceMode) => void;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: GitStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

type EnvironmentGitSectionState = {
  isCommitDialogOpen: boolean;
  dialogCommitMessage: string;
  excludedFiles: ReadonlySet<string>;
  isEditingFiles: boolean;
  isSshPassphraseDialogOpen: boolean;
  isSshPassphraseSaving: boolean;
  sshPassphraseDraft: string;
  pendingDefaultBranchAction: PendingDefaultBranchAction | null;
};

type EnvironmentGitSectionAction =
  | { type: "set-commit-dialog-open"; value: boolean }
  | { type: "set-dialog-commit-message"; value: string }
  | { type: "set-excluded-files"; value: ReadonlySet<string> }
  | { type: "set-editing-files"; value: boolean }
  | { type: "set-ssh-passphrase-dialog-open"; value: boolean }
  | { type: "set-ssh-passphrase-saving"; value: boolean }
  | { type: "set-ssh-passphrase-draft"; value: string }
  | { type: "set-pending-default-branch-action"; value: PendingDefaultBranchAction | null }
  | { type: "reset-commit-dialog" };

const INITIAL_ENVIRONMENT_GIT_SECTION_STATE: EnvironmentGitSectionState = {
  isCommitDialogOpen: false,
  dialogCommitMessage: "",
  excludedFiles: new Set(),
  isEditingFiles: false,
  isSshPassphraseDialogOpen: false,
  isSshPassphraseSaving: false,
  sshPassphraseDraft: "",
  pendingDefaultBranchAction: null,
};

function environmentGitSectionReducer(
  state: EnvironmentGitSectionState,
  action: EnvironmentGitSectionAction,
): EnvironmentGitSectionState {
  switch (action.type) {
    case "set-commit-dialog-open":
      return { ...state, isCommitDialogOpen: action.value };
    case "set-dialog-commit-message":
      return { ...state, dialogCommitMessage: action.value };
    case "set-excluded-files":
      return { ...state, excludedFiles: action.value };
    case "set-editing-files":
      return { ...state, isEditingFiles: action.value };
    case "set-ssh-passphrase-dialog-open":
      return { ...state, isSshPassphraseDialogOpen: action.value };
    case "set-ssh-passphrase-saving":
      return { ...state, isSshPassphraseSaving: action.value };
    case "set-ssh-passphrase-draft":
      return { ...state, sshPassphraseDraft: action.value };
    case "set-pending-default-branch-action":
      return { ...state, pendingDefaultBranchAction: action.value };
    case "reset-commit-dialog":
      return {
        ...state,
        isCommitDialogOpen: false,
        dialogCommitMessage: "",
        excludedFiles: new Set(),
        isEditingFiles: false,
      };
    default:
      return state;
  }
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasOriginRemote,
  isDefaultBranch,
}: {
  item: GitActionMenuItem;
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return "View PR is currently unavailable.";
  }
  if (!hasBranch) {
    return "Detached HEAD: checkout a branch before creating a PR.";
  }
  if (hasChanges) {
    return "Commit local changes before creating a PR.";
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return 'Add an "origin" remote before creating a PR.';
  }
  if (isDefaultBranch && !isAhead) {
    return "Create PR from the default branch is unavailable.";
  }
  if (!gitStatus.hasUpstream && !isAhead) {
    return "No local commits to include in a PR.";
  }
  if (isBehind) {
    return "Branch is behind upstream. Pull/rebase before creating a PR.";
  }
  return "Create PR is currently unavailable.";
}

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

const gitCardRowClassName =
  "flex min-h-8 w-full items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-left text-[13px] leading-none text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-45 [&>svg:not([class*='size-'])]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground";

function GitQuickActionIcon({
  busy = false,
  quickAction,
}: {
  busy?: boolean;
  quickAction: GitQuickAction;
}) {
  const iconClassName = "size-3.5";
  if (busy) return <Spinner className={iconClassName} />;
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <RefreshCwIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

function EnvironmentGitStatusMessage({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "warning" | "error";
}) {
  const Icon = tone === "muted" ? Spinner : AlertTriangleIcon;
  return (
    <output
      className={cn(
        "flex min-h-7 items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-[11px] leading-4",
        tone === "muted" && "bg-muted/18 text-muted-foreground",
        tone === "warning" && "bg-warning/8 text-warning",
        tone === "error" && "bg-destructive/8 text-destructive",
      )}
      {...(tone === "muted" ? { "aria-live": "polite" as const } : { role: "status" })}
    >
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </output>
  );
}

interface GitActionMenuPosition {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

function resolveGitActionMenuPosition(anchorElement: HTMLElement): GitActionMenuPosition {
  const anchorRow = anchorElement.parentElement ?? anchorElement;
  const rect = anchorRow.getBoundingClientRect();
  const viewportPadding = 8;
  const sideOffset = 6;
  const preferredWidth = 232;
  const minimumWidth = 184;
  const width = Math.max(
    minimumWidth,
    Math.min(preferredWidth, window.innerWidth - viewportPadding * 2),
  );
  const rightSideLeft = rect.right + sideOffset;
  const canOpenRight = rightSideLeft + width <= window.innerWidth - viewportPadding;
  const left = canOpenRight
    ? rightSideLeft
    : Math.max(viewportPadding, rect.left - sideOffset - width);
  const top = Math.min(
    Math.max(viewportPadding, rect.top),
    Math.max(viewportPadding, window.innerHeight - viewportPadding - 160),
  );
  const maxHeight = Math.max(160, window.innerHeight - top - viewportPadding);

  return { left, maxHeight, top, width };
}

function EnvironmentGitActionMenuPortal({
  children,
  onClose,
  open,
  triggerRef,
}: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<GitActionMenuPosition | null>(null);

  const updatePosition = useCallback(() => {
    const triggerElement = triggerRef.current;
    if (!triggerElement) return;
    setPosition(resolveGitActionMenuPosition(triggerElement));
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const triggerElement = triggerRef.current;
      if (triggerElement?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [onClose, open, triggerRef, updatePosition]);

  if (!open || !position || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popupRef}
      role="menu"
      className="glass-surface fixed z-[110] flex max-w-[calc(100vw-1rem)] rounded-[calc(var(--panel-radius)-2px)] border text-popover-foreground outline-none"
      style={{
        left: position.left,
        maxHeight: position.maxHeight,
        top: position.top,
        width: position.width,
      }}
    >
      <div className="min-w-0 w-full overflow-y-auto p-1.5">{children}</div>
    </div>,
    document.body,
  );
}

const gitActionMenuItemClassName =
  "flex w-full cursor-default select-none items-center gap-2 rounded-[var(--chip-radius)] px-2 py-0.5 text-left text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-3.5 [&>svg]:pointer-events-none [&>svg]:shrink-0";

function useEnvironmentGitSection({
  connectionUrl,
  editorStateInstanceId,
  gitCwd,
  gitStatus,
  gitStatusError,
  branchList,
  activeThreadId,
  workspaceMode,
  onWorkspaceModeChange,
}: EnvironmentGitSectionProps) {
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const activeServerThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    environmentGitSectionReducer,
    INITIAL_ENVIRONMENT_GIT_SECTION_STATE,
  );
  const {
    dialogCommitMessage,
    excludedFiles,
    isCommitDialogOpen,
    isEditingFiles,
    isSshPassphraseDialogOpen,
    isSshPassphraseSaving,
    pendingDefaultBranchAction,
    sshPassphraseDraft,
  } = state;
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const gitActionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [isGitActionMenuOpen, setGitActionMenuOpen] = useState(false);
  const openFileInWorkspace = useEditorStateStore((state) => state.openFile);
  const configuredGitSshKeyPassphrase = useSettings((settings) => settings.gitSshKeyPassphrase);

  useEffect(() => {
    if (!isSshPassphraseDialogOpen) return;
    dispatch({ type: "set-ssh-passphrase-draft", value: configuredGitSshKeyPassphrase });
  }, [configuredGitSshKeyPassphrase, isSshPassphraseDialogOpen]);

  const persistSshPassphrase = useCallback(
    (passphrase: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Settings are unavailable.",
          data: threadToastData,
        });
        return;
      }

      dispatch({ type: "set-ssh-passphrase-saving", value: true });
      runAsyncTask(
        api.server
          .updateSettings({ gitSshKeyPassphrase: passphrase })
          .then((settings) => {
            applySettingsUpdated(settings);
            dispatch({ type: "set-ssh-passphrase-dialog-open", value: false });
          })
          .catch((err: unknown) => {
            toastManager.add({
              type: "error",
              title: "Failed to save SSH passphrase",
              description: err instanceof Error ? err.message : "An error occurred.",
              data: threadToastData,
            });
          })
          .finally(() => dispatch({ type: "set-ssh-passphrase-saving", value: false })),
        "Failed to persist Git SSH key passphrase.",
      );
    },
    [threadToastData],
  );

  const saveSshPassphrase = () => {
    persistSshPassphrase(sshPassphraseDraft);
  };

  const clearSshPassphrase = () => {
    dispatch({ type: "set-ssh-passphrase-draft", value: "" });
    persistSshPassphrase("");
  };

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: threadToastData,
    });
  }, [threadToastData]);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadId || !activeServerThread || activeServerThread.branch === branch) {
        return;
      }

      const worktreePath = activeServerThread.worktreePath;
      const api = readNativeApi();
      if (api) {
        runAsyncTask(
          api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: activeThreadId,
            branch,
            worktreePath,
          }),
          "Failed to sync thread branch metadata after the git action.",
        );
      }

      setThreadBranch(activeThreadId, branch, worktreePath);
    },
    [activeServerThread, activeThreadId, setThreadBranch],
  );

  const syncThreadBranchAfterGitAction = (result: GitRunStackedActionResult) => {
    const branchUpdate = resolveThreadBranchUpdate(result);
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  };

  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const hasOriginRemote = branchList?.hasOriginRemote ?? false;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const isGitStatusOutOfSync =
    !!gitStatus?.branch && !!currentBranch && gitStatus.branch !== currentBranch;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient, { cwd: gitCwd });
  }, [gitCwd, isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initMutation = useMutation(
    gitInitMutationOptions({ connectionUrl, cwd: gitCwd, queryClient }),
  );

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      cwd: gitCwd,
      queryClient,
    }),
  );
  const pullMutation = useMutation(
    gitPullMutationOptions({ connectionUrl, cwd: gitCwd, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;

  useEffect(() => {
    if (isGitActionRunning) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeServerThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    persistThreadBranchSync,
  ]);

  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);

  const gitActionMenuItems = buildMenuItems(
    gitStatusForActions,
    isGitActionRunning,
    hasOriginRemote,
    isDefaultBranch,
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultBranch, hasOriginRemote),
    [gitStatusForActions, hasOriginRemote, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions, threadToastData]);

  const runGitActionWithToast = async ({
    action,
    commitMessage,
    onConfirmed,
    skipDefaultBranchPrompt = false,
    statusOverride,
    featureBranch = false,
    progressToastId,
    filePaths,
  }: RunGitActionWithToastInput) => {
    const actionStatus = statusOverride ?? gitStatusForActions;
    const actionBranch = actionStatus?.branch ?? null;
    const actionIsDefaultBranch = featureBranch ? false : isDefaultBranch;
    const actionCanCommit =
      action === "commit" || action === "commit_push" || action === "commit_push_pr";
    const includesCommit =
      actionCanCommit &&
      (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
    if (
      !skipDefaultBranchPrompt &&
      requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
      actionBranch
    ) {
      if (
        action !== "push" &&
        action !== "create_pr" &&
        action !== "commit_push" &&
        action !== "commit_push_pr"
      ) {
        return;
      }
      dispatch({
        type: "set-pending-default-branch-action",
        value: {
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        },
      });
      return;
    }
    onConfirmed?.();

    const progressStages = buildGitActionProgressStages({
      action,
      hasCustomCommitMessage: !!commitMessage?.trim(),
      hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
      featureBranch,
      shouldPushBeforePr:
        action === "create_pr" &&
        (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
    });
    const actionId = randomUUID();
    const resolvedProgressToastId =
      progressToastId ??
      toastManager.add({
        type: "loading",
        title: progressStages[0] ?? "Running git action...",
        description: "Waiting for Git...",
        timeout: 0,
        data: threadToastData,
      });

    activeGitActionProgressRef.current = {
      toastId: resolvedProgressToastId,
      actionId,
      title: progressStages[0] ?? "Running git action...",
      phaseStartedAtMs: null,
      hookStartedAtMs: null,
      hookName: null,
      lastOutputLine: null,
      currentPhaseLabel: progressStages[0] ?? "Running git action...",
    };

    if (progressToastId) {
      toastManager.update(progressToastId, {
        type: "loading",
        title: progressStages[0] ?? "Running git action...",
        description: "Waiting for Git...",
        timeout: 0,
        data: threadToastData,
      });
    }

    const applyProgressEvent = (event: GitActionProgressEvent) => {
      const progress = activeGitActionProgressRef.current;
      if (!progress) {
        return;
      }
      if (gitCwd && event.cwd !== gitCwd) {
        return;
      }
      if (progress.actionId !== event.actionId) {
        return;
      }

      const now = Date.now();
      switch (event.kind) {
        case "action_started":
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "phase_started":
          progress.title = event.label;
          progress.currentPhaseLabel = event.label;
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "hook_started":
          progress.title = `Running ${event.hookName}...`;
          progress.hookName = event.hookName;
          progress.hookStartedAtMs = now;
          progress.lastOutputLine = null;
          break;
        case "hook_output":
          progress.lastOutputLine = event.text;
          break;
        case "hook_finished":
          progress.title = progress.currentPhaseLabel ?? "Committing...";
          progress.hookName = null;
          progress.hookStartedAtMs = null;
          progress.lastOutputLine = null;
          break;
        case "action_finished":
          // Let the resolved mutation update the toast so we keep the
          // elapsed description visible until the final success state renders.
          return;
        case "action_failed":
          // Let the rejected mutation publish the error toast to avoid a
          // transient intermediate state before the final failure message.
          return;
      }

      updateActiveProgressToast();
    };

    const promise = runImmediateGitActionMutation.mutateAsync({
      actionId,
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(featureBranch ? { featureBranch } : {}),
      ...(filePaths ? { filePaths } : {}),
      ...(activeServerThread?.modelSelection
        ? { modelSelection: activeServerThread.modelSelection }
        : {}),
      onProgress: applyProgressEvent,
    });

    try {
      const result = await promise;
      activeGitActionProgressRef.current = null;
      syncThreadBranchAfterGitAction(result);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = result.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: () => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            closeResultToast();
            void runGitActionWithToast({
              action: toastCta.action.kind,
            });
          },
        };
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            const api = readNativeApi();
            if (!api) return;
            closeResultToast();
            void api.shell.openExternal(toastCta.url);
          },
        };
      }

      toastManager.update(resolvedProgressToastId, {
        type: "success",
        title: result.toast.title,
        description: result.toast.description,
        timeout: 0,
        data: {
          ...threadToastData,
          dismissAfterVisibleMs: 10_000,
        },
        ...(toastActionProps ? { actionProps: toastActionProps } : {}),
      });
    } catch (err) {
      activeGitActionProgressRef.current = null;
      toastManager.update(resolvedProgressToastId, {
        type: "error",
        title: "Action failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    }
  };

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    dispatch({ type: "set-pending-default-branch-action", value: null });
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    dispatch({ type: "set-pending-default-branch-action", value: null });
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    dispatch({ type: "reset-commit-dialog" });

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      runAsyncTask(promise, "Git quick action promise rejected after toast handling.");
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    dispatch({ type: "set-excluded-files", value: new Set() });
    dispatch({ type: "set-editing-files", value: false });
    dispatch({ type: "set-commit-dialog-open", value: true });
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    dispatch({ type: "reset-commit-dialog" });
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = (filePath: string) => {
    if (!activeThreadId || !gitCwd) {
      toastManager.add({
        type: "error",
        title: "Workspace editor is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const relativePath = filePath.trim();
    if (!relativePath) {
      return;
    }
    if (workspaceMode === "chat") {
      onWorkspaceModeChange("editor");
    }
    openFileInWorkspace(
      resolveEditorInstanceStateScopeId({
        gitCwd,
        instanceId: editorStateInstanceId,
        threadId: activeThreadId,
      }),
      relativePath,
    );
  };

  const closeGitActionMenu = () => {
    setGitActionMenuOpen(false);
  };

  const toggleGitActionMenu = () => {
    setGitActionMenuOpen((open) => !open);
  };

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <div className="space-y-2">
          <button
            type="button"
            className={gitCardRowClassName}
            disabled={initMutation.isPending}
            onClick={() => initMutation.mutate()}
          >
            {initMutation.isPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <GitBranchPlusIcon className="size-3.5" />
            )}
            <span>{initMutation.isPending ? "Initializing Git" : "Initialize Git"}</span>
          </button>
          {gitStatusError ? (
            <EnvironmentGitStatusMessage tone="error">
              {gitStatusError.message}
            </EnvironmentGitStatusMessage>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {isGitStatusOutOfSync ? (
            <EnvironmentGitStatusMessage>Refreshing git state</EnvironmentGitStatusMessage>
          ) : null}
          <div className="flex min-h-8 w-full overflow-hidden rounded-[var(--control-radius)]">
            <button
              type="button"
              className={cn(
                gitCardRowClassName,
                "min-h-8 flex-1 rounded-none bg-transparent px-2 py-1 hover:bg-accent",
              )}
              disabled={isGitActionRunning || quickAction.disabled}
              title={quickActionDisabledReason ?? undefined}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon busy={isGitActionRunning} quickAction={quickAction} />
              <span className="min-w-0 flex-1 truncate">{quickAction.label}</span>
            </button>
            <button
              ref={gitActionMenuTriggerRef}
              type="button"
              className={cn(
                "flex min-h-8 w-8 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-0",
                isGitActionMenuOpen && "bg-accent text-accent-foreground",
              )}
              aria-expanded={isGitActionMenuOpen}
              aria-haspopup="menu"
              aria-label="Open git actions"
              onClick={toggleGitActionMenu}
            >
              <ChevronDownIcon className="size-3.5" />
            </button>
          </div>
          <EnvironmentGitActionMenuPortal
            open={isGitActionMenuOpen}
            triggerRef={gitActionMenuTriggerRef}
            onClose={closeGitActionMenu}
          >
            <button
              type="button"
              role="menuitem"
              className={cn(gitActionMenuItemClassName, "min-h-8 text-[13px]")}
              disabled={isGitActionRunning || quickAction.disabled}
              title={quickActionDisabledReason ?? undefined}
              onClick={() => {
                closeGitActionMenu();
                runQuickAction();
              }}
            >
              <GitQuickActionIcon busy={isGitActionRunning} quickAction={quickAction} />
              <span className="whitespace-nowrap">{quickAction.label}</span>
            </button>
            <div className="mx-2 my-1 h-px bg-border" />
            <div className="space-y-0">
              {gitActionMenuItems.map((item) => {
                const disabledReason = getMenuActionDisabledReason({
                  item,
                  gitStatus: gitStatusForActions,
                  isBusy: isGitActionRunning,
                  hasOriginRemote,
                  isDefaultBranch,
                });
                return (
                  <button
                    key={`${item.id}-${item.label}`}
                    type="button"
                    role="menuitem"
                    className={cn(gitActionMenuItemClassName, "min-h-7 text-[12px]")}
                    disabled={item.disabled}
                    title={disabledReason ?? undefined}
                    onClick={() => {
                      closeGitActionMenu();
                      openDialogForMenuItem(item);
                    }}
                  >
                    <GitActionItemIcon icon={item.icon} />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mx-2 my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              className={cn(gitActionMenuItemClassName, "min-h-7 text-[12px]")}
              onClick={() => {
                closeGitActionMenu();
                dispatch({ type: "set-ssh-passphrase-dialog-open", value: true });
              }}
            >
              <KeyRoundIcon />
              <span className="whitespace-nowrap">SSH key passphrase</span>
            </button>
          </EnvironmentGitActionMenuPortal>
          {gitStatusForActions?.branch === null ? (
            <EnvironmentGitStatusMessage tone="warning">
              Detached HEAD: create and checkout a branch to enable push and PR actions.
            </EnvironmentGitStatusMessage>
          ) : null}
          {gitStatusForActions &&
          gitStatusForActions.branch !== null &&
          !gitStatusForActions.hasWorkingTreeChanges &&
          gitStatusForActions.behindCount > 0 &&
          gitStatusForActions.aheadCount === 0 ? (
            <EnvironmentGitStatusMessage tone="warning">
              Behind upstream. Pull/rebase first.
            </EnvironmentGitStatusMessage>
          ) : null}
          {gitStatusError ? (
            <EnvironmentGitStatusMessage tone="error">
              {gitStatusError.message}
            </EnvironmentGitStatusMessage>
          ) : null}
        </div>
      )}

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "reset-commit-dialog" });
          }
        }}
      >
        <DialogPopup className={`${HEADER_ACTION_DIALOG_POPUP_CLASS_NAME} max-w-2xl`}>
          <DialogHeader className={HEADER_ACTION_DIALOG_HEADER_CLASS_NAME}>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription className="max-w-xl">{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogPanel className={HEADER_ACTION_DIALOG_PANEL_CLASS_NAME}>
            <div className={`${HEADER_ACTION_FIELD_CARD_CLASS_NAME} space-y-3 p-3 text-xs`}>
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground/88">
                    {gitStatusForActions?.branch ?? "(detached HEAD)"}
                  </span>
                  {isDefaultBranch && (
                    <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-right text-warning text-xs">
                      Default branch
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          dispatch({
                            type: "set-excluded-files",
                            value: allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          });
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-foreground/72 hover:bg-accent hover:text-foreground"
                      onClick={() =>
                        dispatch({ type: "set-editing-files", value: !isEditingFiles })
                      }
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-lg border border-border/45 bg-background/66">
                      <div className="space-y-1 p-1">
                        {allFiles.map((file) => {
                          const isExcluded = excludedFiles.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!excludedFiles.has(file.path)}
                                  onCheckedChange={() => {
                                    const next = new Set(excludedFiles);
                                    if (next.has(file.path)) {
                                      next.delete(file.path);
                                    } else {
                                      next.add(file.path);
                                    }
                                    dispatch({ type: "set-excluded-files", value: next });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex flex-1 items-center justify-between gap-3 text-left truncate"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <span
                                  className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}
                                >
                                  {file.path}
                                </span>
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">Excluded</span>
                                  ) : (
                                    <>
                                      <span className="text-success">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-destructive">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) =>
                  dispatch({ type: "set-dialog-commit-message", value: event.target.value })
                }
                placeholder="Leave empty to auto-generate"
                size="sm"
                className={`${HEADER_ACTION_FIELD_CONTROL_CLASS_NAME} min-h-24`}
              />
            </div>
          </DialogPanel>
          <DialogFooter className={HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                dispatch({ type: "reset-commit-dialog" });
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isSshPassphraseDialogOpen}
        onOpenChange={(open) => {
          if (!isSshPassphraseSaving) {
            dispatch({ type: "set-ssh-passphrase-dialog-open", value: open });
          }
        }}
      >
        <DialogPopup className={`${HEADER_ACTION_DIALOG_POPUP_CLASS_NAME} max-w-md`}>
          <DialogHeader className={HEADER_ACTION_DIALOG_HEADER_CLASS_NAME}>
            <DialogTitle>SSH key passphrase</DialogTitle>
            <DialogDescription>
              Saved for git SSH fetch, push, and pull request checkout.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className={HEADER_ACTION_DIALOG_PANEL_CLASS_NAME}>
            <label htmlFor="git-ssh-passphrase" className="grid gap-1.5">
              <span className={HEADER_ACTION_FIELD_LABEL_CLASS_NAME}>Passphrase</span>
              <Input
                id="git-ssh-passphrase"
                type="password"
                value={sshPassphraseDraft}
                className={HEADER_ACTION_FIELD_CONTROL_CLASS_NAME}
                onChange={(event) =>
                  dispatch({ type: "set-ssh-passphrase-draft", value: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  if (!isSshPassphraseSaving) {
                    saveSshPassphrase();
                  }
                }}
                autoComplete="off"
                placeholder="Optional private key passphrase"
                aria-label="Git SSH key passphrase"
              />
            </label>
            <p className="text-muted-foreground text-xs">
              {configuredGitSshKeyPassphrase.trim().length > 0 ? "Configured" : "Not set"}
            </p>
          </DialogPanel>
          <DialogFooter className={HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isSshPassphraseSaving}
              onClick={() => dispatch({ type: "set-ssh-passphrase-dialog-open", value: false })}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSshPassphraseSaving}
              onClick={clearSshPassphrase}
            >
              Clear
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={isSshPassphraseSaving}
              onClick={saveSshPassphrase}
            >
              {isSshPassphraseSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "set-pending-default-branch-action", value: null });
          }
        }}
      >
        <DialogPopup className={`${HEADER_ACTION_DIALOG_POPUP_CLASS_NAME} max-w-xl`}>
          <DialogHeader className={HEADER_ACTION_DIALOG_HEADER_CLASS_NAME}>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel className={HEADER_ACTION_DIALOG_PANEL_CLASS_NAME}>
            <div
              className={`${HEADER_ACTION_FIELD_CARD_CLASS_NAME} p-3 text-sm text-muted-foreground`}
            >
              Running Git actions on the default branch can change the main project history. Use a
              feature branch when the work should stay isolated.
            </div>
          </DialogPanel>
          <DialogFooter className={HEADER_ACTION_DIALOG_FOOTER_CLASS_NAME}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => dispatch({ type: "set-pending-default-branch-action", value: null })}
            >
              Abort
            </Button>
            <Button variant="outline" size="sm" onClick={continuePendingDefaultBranchAction}>
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button size="sm" onClick={checkoutFeatureBranchAndContinuePendingAction}>
              Checkout feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export default function EnvironmentGitSection(props: EnvironmentGitSectionProps) {
  return useEnvironmentGitSection(props);
}
