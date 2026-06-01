import { type RuntimeMode, type ThreadId } from "@ace/contracts";
import {
  ArrowLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  CloudOffIcon,
  ExternalLinkIcon,
  FolderIcon,
  GaugeIcon,
  GitForkIcon,
  LaptopIcon,
  LockIcon,
  LockOpenIcon,
} from "lucide-react";
import { useCallback } from "react";

import { runAsyncTask } from "../lib/async";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "../lib/git/branchToolbar";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { ProjectGlyphIcon } from "./ProjectAvatar";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import type { Project } from "../types";

function nextAccessMode(mode: RuntimeMode): RuntimeMode {
  switch (mode) {
    case "approval-required":
      return "full-access";
    case "full-access":
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
      "text-emerald-600 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-300",
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  "full-access": {
    label: "Full access",
    title: "Full access — click to switch to Supervised",
    textClassName:
      "text-amber-600 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300",
    iconClassName: "text-amber-600 dark:text-amber-400",
  },
};

interface BranchToolbarProps {
  threadId: ThreadId;
  currentBranchName: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  presentation?: "footer" | "environment";
  localEnvironmentLabel?: string;
  localEnvironmentIcon?: Project["icon"];
  runtimeMode?: RuntimeMode;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function EnvironmentModeMenu(props: {
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  localEnvironmentIcon: Project["icon"];
  localEnvironmentLabel: string;
  onEnvModeSelect: (mode: EnvMode) => void;
  rowClassName: string;
}) {
  const isLocal = props.effectiveEnvMode === "local";
  const label = isLocal ? props.localEnvironmentLabel : "Worktree";
  const icon = isLocal ? (
    props.localEnvironmentIcon ? (
      <ProjectGlyphIcon icon={props.localEnvironmentIcon} className="size-4 opacity-80" />
    ) : (
      <LaptopIcon className="size-4 text-muted-foreground" />
    )
  ) : (
    <GitForkIcon className="size-4 text-muted-foreground" />
  );

  if (props.envLocked) {
    return (
      <div className={props.rowClassName}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        className={`${props.rowClassName} data-popup-open:bg-accent data-popup-open:text-accent-foreground`}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="left"
        className="w-80 rounded-2xl"
        listClassName="p-2"
        sideOffset={6}
      >
        <MenuGroupLabel className="px-2 pb-2 pt-1 text-[15px] font-normal normal-case text-muted-foreground">
          Continue in
        </MenuGroupLabel>
        <MenuItem
          className="min-h-10 gap-3 rounded-xl px-2 text-[15px]"
          onClick={() => props.onEnvModeSelect("local")}
        >
          <LaptopIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Work locally</span>
          {isLocal ? <CheckIcon className="size-4 text-muted-foreground" /> : null}
        </MenuItem>
        <MenuItem className="min-h-10 gap-3 rounded-xl px-2 text-[15px]">
          <CloudIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Connect Codex web</span>
          <ExternalLinkIcon className="size-4 text-muted-foreground" />
        </MenuItem>
        <MenuItem disabled className="min-h-10 gap-3 rounded-xl px-2 text-[15px]">
          <CloudOffIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Send to cloud</span>
        </MenuItem>
        <MenuSeparator className="mx-2 my-2" />
        <MenuSub>
          <MenuSubTrigger className="min-h-10 gap-3 rounded-xl px-2 text-[15px]">
            <GaugeIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Usage remaining</span>
          </MenuSubTrigger>
          <MenuSubPopup className="w-64 rounded-2xl" listClassName="p-2">
            <MenuGroupLabel className="px-2 py-1 text-[13px] font-normal normal-case text-muted-foreground">
              Usage remaining
            </MenuGroupLabel>
            <MenuItem disabled className="min-h-9 rounded-xl px-2 text-sm">
              <span className="min-w-0 flex-1 truncate">Local usage is unlimited</span>
            </MenuItem>
            <MenuItem disabled className="min-h-9 rounded-xl px-2 text-sm">
              <span className="min-w-0 flex-1 truncate">Cloud usage unavailable</span>
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator className="mx-2 my-2" />
        <MenuItem
          className="min-h-10 gap-3 rounded-xl px-2 text-[15px]"
          disabled={!isLocal}
          onClick={() => props.onEnvModeSelect("worktree")}
        >
          <ArrowLeftRightIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Handoff to worktree</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export default function BranchToolbar({
  threadId,
  currentBranchName,
  onEnvModeChange,
  envLocked,
  presentation = "footer",
  localEnvironmentLabel = "Local",
  localEnvironmentIcon = null,
  runtimeMode,
  onRuntimeModeChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const serverThread = useThreadById(threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useProjectById(activeProjectId);
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
  const handleEnvModeSelect = useCallback(
    (mode: EnvMode) => {
      if (mode === "worktree" && !activeWorktreePath && !activeThreadBranch && currentBranchName) {
        setThreadBranch(currentBranchName, null);
      }
      onEnvModeChange(mode);
    },
    [activeThreadBranch, activeWorktreePath, currentBranchName, onEnvModeChange, setThreadBranch],
  );

  if (!activeThreadId || !activeProject) return null;
  const runtimeModeMeta = runtimeMode ? ACCESS_MODE_META[runtimeMode] : null;
  const isEnvironmentPresentation = presentation === "environment";
  const envModeItems = [
    { value: "local", label: localEnvironmentLabel },
    { value: "worktree", label: "New worktree" },
  ] as const;
  const localModeIcon = localEnvironmentIcon ? (
    <ProjectGlyphIcon icon={localEnvironmentIcon} className="size-3 opacity-80" />
  ) : (
    <FolderIcon className="size-3 opacity-60" />
  );
  const environmentModeRowClassName =
    "flex min-h-9 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[15px] font-normal text-foreground transition-colors hover:bg-accent hover:text-accent-foreground";
  if (isEnvironmentPresentation) {
    return (
      <div className="space-y-1">
        <EnvironmentModeMenu
          effectiveEnvMode={activeWorktreePath ? "worktree" : effectiveEnvMode}
          envLocked={envLocked}
          localEnvironmentIcon={localEnvironmentIcon}
          localEnvironmentLabel={activeWorktreePath ? "Worktree" : localEnvironmentLabel}
          rowClassName={environmentModeRowClassName}
          onEnvModeSelect={handleEnvModeSelect}
        />

        <BranchToolbarBranchSelector
          activeProjectCwd={activeProject.cwd}
          activeThreadBranch={activeThreadBranch}
          activeWorktreePath={activeWorktreePath}
          branchCwd={branchCwd}
          effectiveEnvMode={effectiveEnvMode}
          envLocked={envLocked}
          presentation="environment"
          onSetThreadBranch={setThreadBranch}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />

        {runtimeMode && onRuntimeModeChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={environmentModeRowClassName}
                  onClick={() => onRuntimeModeChange(nextAccessMode(runtimeMode))}
                  aria-label={runtimeModeMeta?.title}
                  data-chat-branch-runtime-mode={runtimeMode}
                />
              }
            >
              {runtimeMode === "full-access" ? (
                <LockOpenIcon
                  className={`size-4 ${runtimeModeMeta?.iconClassName ?? "text-muted-foreground"}`}
                />
              ) : (
                <LockIcon
                  className={`size-4 ${runtimeModeMeta?.iconClassName ?? "text-muted-foreground"}`}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{runtimeModeMeta?.label ?? "Access"}</span>
            </TooltipTrigger>
            {runtimeModeMeta?.title ? (
              <TooltipPopup side="left">{runtimeModeMeta.title}</TooltipPopup>
            ) : null}
          </Tooltip>
        ) : null}
      </div>
    );
  }

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
                {localModeIcon}
                {localEnvironmentLabel}
              </>
            )}
          </span>
        ) : (
          <Select
            value={effectiveEnvMode}
            onValueChange={(value) => handleEnvModeSelect(value as EnvMode)}
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
                localModeIcon
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">
                <span className="inline-flex items-center gap-1.5">
                  {localEnvironmentIcon ? (
                    <ProjectGlyphIcon icon={localEnvironmentIcon} className="size-3 opacity-80" />
                  ) : (
                    <FolderIcon className="size-3" />
                  )}
                  {localEnvironmentLabel}
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    className={`gap-1.5 rounded-md text-[11px] font-medium tracking-wide uppercase transition-colors duration-150 ${runtimeModeMeta?.textClassName ?? "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => onRuntimeModeChange(nextAccessMode(runtimeMode))}
                    aria-label={runtimeModeMeta?.title}
                    data-chat-branch-runtime-mode={runtimeMode}
                  />
                }
              >
                {runtimeMode === "full-access" ? (
                  <LockOpenIcon
                    className={`size-3 opacity-80 ${runtimeModeMeta?.iconClassName ?? ""}`}
                  />
                ) : (
                  <LockIcon
                    className={`size-3 opacity-80 ${runtimeModeMeta?.iconClassName ?? ""}`}
                  />
                )}
                {runtimeModeMeta?.label ?? "Access"}
              </TooltipTrigger>
              {runtimeModeMeta?.title ? (
                <TooltipPopup side="top">{runtimeModeMeta.title}</TooltipPopup>
              ) : null}
            </Tooltip>
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
