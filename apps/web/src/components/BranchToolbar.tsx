import { type ThreadId } from "@ace/contracts";
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
import {
  Menu,
  MenuGroup,
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
import type { Project } from "../types";

interface BranchToolbarProps {
  threadId: ThreadId;
  currentBranchName: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  presentation?: "footer" | "environment";
  localEnvironmentLabel?: string;
  localEnvironmentIcon?: Project["icon"];
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
      <ProjectGlyphIcon icon={props.localEnvironmentIcon} className="size-3.5 opacity-80" />
    ) : (
      <LaptopIcon className="size-3.5 text-muted-foreground" />
    )
  ) : (
    <GitForkIcon className="size-3.5 text-muted-foreground" />
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
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        side="bottom"
        className="w-72 rounded-2xl shadow-2xl shadow-black/25"
        listClassName="p-2"
        sideOffset={6}
      >
        <MenuGroup>
          <MenuGroupLabel className="px-2 pb-1.5 pt-1 text-[13px] font-normal normal-case text-muted-foreground">
            Continue in
          </MenuGroupLabel>
          <MenuItem
            className="min-h-9 gap-2 rounded-xl px-2 text-[13px]"
            onClick={() => props.onEnvModeSelect("local")}
          >
            <LaptopIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Work locally</span>
            {isLocal ? <CheckIcon className="size-3.5 text-muted-foreground" /> : null}
          </MenuItem>
          <MenuItem className="min-h-9 gap-2 rounded-xl px-2 text-[13px]">
            <CloudIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Connect Codex web</span>
            <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
          </MenuItem>
          <MenuItem disabled className="min-h-9 gap-2 rounded-xl px-2 text-[13px]">
            <CloudOffIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Send to cloud</span>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator className="mx-2 my-2" />
        <MenuGroup>
          <MenuSub>
            <MenuSubTrigger className="min-h-9 gap-2 rounded-xl px-2 text-[13px]">
              <GaugeIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Usage remaining</span>
            </MenuSubTrigger>
            <MenuSubPopup
              className="w-64 rounded-2xl shadow-2xl shadow-black/25"
              listClassName="p-2"
              sideOffset={8}
            >
              <MenuGroup>
                <MenuGroupLabel className="px-2 py-1 text-[13px] font-normal normal-case text-muted-foreground">
                  Usage remaining
                </MenuGroupLabel>
                <MenuItem disabled className="min-h-8 rounded-xl px-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">Local usage is unlimited</span>
                </MenuItem>
                <MenuItem disabled className="min-h-8 rounded-xl px-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">Cloud usage unavailable</span>
                </MenuItem>
              </MenuGroup>
            </MenuSubPopup>
          </MenuSub>
        </MenuGroup>
        <MenuSeparator className="mx-2 my-2" />
        <MenuGroup>
          <MenuItem
            className="min-h-9 gap-2 rounded-xl px-2 text-[13px]"
            disabled={!isLocal}
            onClick={() => props.onEnvModeSelect("worktree")}
          >
            <ArrowLeftRightIcon className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Handoff to worktree</span>
          </MenuItem>
        </MenuGroup>
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
    "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] font-normal text-foreground transition-colors hover:bg-accent hover:text-accent-foreground";
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
