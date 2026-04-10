import { type RuntimeMode, type ThreadId } from "@ace/contracts";
import { FolderIcon, GitForkIcon, LockIcon, LockOpenIcon, SparklesIcon } from "lucide-react";
import { useCallback } from "react";

import { runAsyncTask } from "../lib/async";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "../lib/git/branchToolbar";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

function nextAccessMode(mode: RuntimeMode): RuntimeMode {
  switch (mode) {
    case "approval-required":
      return "full-access";
    case "full-access":
      return "andy";
    case "andy":
    default:
      return "approval-required";
  }
}

const ACCESS_MODE_META: Record<
  RuntimeMode,
  { label: string; title: string; textClassName: string; iconClassName: string }
> = {
  "approval-required": {
    label: "Supervised",
    title: "Supervised — click to switch to Full access",
    textClassName:
      "text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300",
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
  "full-access": {
    label: "Full access",
    title: "Full access — click to switch to Andy",
    textClassName:
      "text-emerald-600 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  andy: {
    label: "Andy",
    title: "Andy — full access with automation profile (click for Supervised)",
    textClassName: "text-sky-600 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300",
    iconClassName: "text-sky-600 dark:text-sky-400",
  },
};

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  runtimeMode?: RuntimeMode;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  runtimeMode,
  onRuntimeModeChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        runAsyncTask(
          api.orchestration.dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          }),
          "Failed to stop the previous session after switching thread environment mode.",
        );
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  if (!activeThreadId || !activeProject) return null;
  const runtimeModeMeta = runtimeMode ? ACCESS_MODE_META[runtimeMode] : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 pb-2 pt-0.5">
      <div className="flex items-center gap-0.5">
        {envLocked || activeWorktreePath ? (
          <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {activeWorktreePath ? (
              <>
                <GitForkIcon className="size-3 opacity-60" />
                Worktree
              </>
            ) : (
              <>
                <FolderIcon className="size-3 opacity-60" />
                Local
              </>
            )}
          </span>
        ) : (
          <Select
            value={effectiveEnvMode}
            onValueChange={(value) => onEnvModeChange(value as EnvMode)}
            items={envModeItems}
          >
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="gap-1.5 rounded-md text-[11px] font-medium tracking-wide text-muted-foreground uppercase transition-colors duration-150 hover:text-foreground"
            >
              {effectiveEnvMode === "worktree" ? (
                <GitForkIcon className="size-3 opacity-60" />
              ) : (
                <FolderIcon className="size-3 opacity-60" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">
                <span className="inline-flex items-center gap-1.5">
                  <FolderIcon className="size-3" />
                  Local
                </span>
              </SelectItem>
              <SelectItem value="worktree">
                <span className="inline-flex items-center gap-1.5">
                  <GitForkIcon className="size-3" />
                  New worktree
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        )}
        {runtimeMode && onRuntimeModeChange ? (
          <>
            <span className="mx-0.5 h-3 w-px bg-border/50" />
            <Button
              variant="ghost"
              size="xs"
              className={`gap-1.5 rounded-md text-[11px] font-medium tracking-wide uppercase transition-colors duration-150 ${runtimeModeMeta?.textClassName ?? "text-muted-foreground hover:text-foreground"}`}
              onClick={() => onRuntimeModeChange(nextAccessMode(runtimeMode))}
              title={runtimeModeMeta?.title}
              data-chat-branch-runtime-mode={runtimeMode}
            >
              {runtimeMode === "andy" ? (
                <SparklesIcon
                  className={`size-3 opacity-80 ${runtimeModeMeta?.iconClassName ?? ""}`}
                />
              ) : runtimeMode === "full-access" ? (
                <LockOpenIcon
                  className={`size-3 opacity-80 ${runtimeModeMeta?.iconClassName ?? ""}`}
                />
              ) : (
                <LockIcon className={`size-3 opacity-80 ${runtimeModeMeta?.iconClassName ?? ""}`} />
              )}
              {runtimeModeMeta?.label ?? "Access"}
            </Button>
          </>
        ) : null}
      </div>

      <BranchToolbarBranchSelector
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
