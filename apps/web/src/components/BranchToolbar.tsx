import { type ThreadId } from "@ace/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderGit2Icon,
  GitBranchPlusIcon,
  GitForkIcon,
  LaptopIcon,
  MonitorIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { runAsyncTask } from "../lib/async";
import { cn, newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import { toastManager } from "./ui/toast";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "../lib/git/branchToolbar";
import {
  CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT,
  loadConnectedRemoteHostIds,
  loadRemoteHostInstances,
  REMOTE_HOSTS_CHANGED_EVENT,
  resolveHostConnectionWsUrl,
  resolveLocalDeviceWsUrl,
  type RemoteHostInstance,
} from "../lib/remoteHosts";
import { normalizeWsUrl } from "@ace/shared/hostConnections";
import type { ReactNode } from "react";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { ProjectGlyphIcon } from "./ProjectAvatar";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import type { Project } from "../types";

function EnvironmentMenuRowContent({
  icon,
  label,
  meta,
}: {
  icon: ReactNode;
  label: string;
  meta?: ReactNode;
}) {
  return (
    <>
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">{label}</span>
      {meta ? <span className="shrink-0 self-center text-muted-foreground">{meta}</span> : null}
    </>
  );
}

interface BranchToolbarProps {
  threadId: ThreadId;
  currentBranchName: string | null;
  connectionUrl?: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  envModeOverride?: EnvMode | null;
  envLocked: boolean;
  presentation?: "footer" | "environment" | "draft";
  localEnvironmentLabel?: string;
  localEnvironmentIcon?: Project["icon"];
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  onNewWorktreeRequest?: () => void;
}

type ConnectedRemoteEnvironment = {
  readonly host: RemoteHostInstance;
  readonly connectionUrl: string;
};

const LOCAL_ENVIRONMENT_LABEL = "Locally";

function loadConnectedRemoteEnvironments(): ConnectedRemoteEnvironment[] {
  const localConnectionUrl = normalizeWsUrl(resolveLocalDeviceWsUrl());
  const connectedHostIds = new Set(loadConnectedRemoteHostIds());
  return loadRemoteHostInstances()
    .filter((host) => connectedHostIds.has(host.id))
    .map((host) => ({ host, connectionUrl: resolveHostConnectionWsUrl(host) }))
    .filter((environment) => normalizeWsUrl(environment.connectionUrl) !== localConnectionUrl)
    .toSorted((left, right) => left.host.name.localeCompare(right.host.name));
}

function useConnectedRemoteEnvironments() {
  const [environments, setEnvironments] = useState<ConnectedRemoteEnvironment[]>(() =>
    loadConnectedRemoteEnvironments(),
  );

  useEffect(() => {
    const refresh = () => setEnvironments(loadConnectedRemoteEnvironments());
    window.addEventListener(REMOTE_HOSTS_CHANGED_EVENT, refresh);
    window.addEventListener(CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(REMOTE_HOSTS_CHANGED_EVENT, refresh);
      window.removeEventListener(CONNECTED_REMOTE_HOST_IDS_CHANGED_EVENT, refresh);
    };
  }, []);

  return environments;
}

function EnvironmentModeMenu(props: {
  activeWorktreePath: string | null;
  activeConnectionUrl: string | null;
  canCreateNewWorktree: boolean;
  connectedRemoteEnvironments: readonly ConnectedRemoteEnvironment[];
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  localEnvironmentIcon: Project["icon"];
  localEnvironmentLabel: string;
  onEnvModeSelect: (mode: EnvMode) => void;
  onNewWorktreeRequest?: () => void;
  rowClassName: string;
}) {
  const isExistingWorktree = props.activeWorktreePath !== null;
  const isPendingNewWorktree = props.effectiveEnvMode === "worktree" && !isExistingWorktree;
  const isLocal = props.effectiveEnvMode === "local" && !isExistingWorktree;
  const activeConnectionUrl = props.activeConnectionUrl
    ? normalizeWsUrl(props.activeConnectionUrl)
    : null;
  const isRemote = activeConnectionUrl !== null;
  const label = isExistingWorktree
    ? isRemote
      ? "Remote worktree"
      : "Worktree"
    : props.effectiveEnvMode === "worktree"
      ? "New worktree"
      : LOCAL_ENVIRONMENT_LABEL;
  const icon = isLocal ? (
    props.localEnvironmentIcon ? (
      <ProjectGlyphIcon icon={props.localEnvironmentIcon} className="size-3.5 opacity-80" />
    ) : (
      <LaptopIcon className="size-3.5 text-muted-foreground" />
    )
  ) : isPendingNewWorktree ? (
    <GitBranchPlusIcon className="size-3.5 text-muted-foreground" />
  ) : (
    <FolderGit2Icon className="size-3.5 text-muted-foreground" />
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
        className="w-56 rounded-2xl shadow-2xl shadow-black/25"
        listClassName="p-1.5"
        sideOffset={6}
      >
        <MenuGroup>
          <MenuItem
            className="min-h-9 items-center gap-2 rounded-xl px-2 py-1 text-[13px]"
            onClick={() => props.onEnvModeSelect("local")}
          >
            <EnvironmentMenuRowContent
              icon={<LaptopIcon className="size-3.5" />}
              label={LOCAL_ENVIRONMENT_LABEL}
              meta={
                isLocal && activeConnectionUrl === null ? <CheckIcon className="size-3.5" /> : null
              }
            />
          </MenuItem>
          {isExistingWorktree ? (
            <MenuItem
              className="min-h-9 items-center gap-2 rounded-xl px-2 py-1 text-[13px]"
              disabled
            >
              <EnvironmentMenuRowContent
                icon={<FolderGit2Icon className="size-3.5" />}
                label={isRemote ? "Remote worktree" : "Worktree"}
                meta={<CheckIcon className="size-3.5" />}
              />
            </MenuItem>
          ) : null}
          {props.connectedRemoteEnvironments.map((environment) => {
            const normalizedConnectionUrl = normalizeWsUrl(environment.connectionUrl);
            const isActiveRemote = activeConnectionUrl === normalizedConnectionUrl;
            return (
              <MenuItem
                key={environment.host.id}
                className={cn(
                  "min-h-9 items-center gap-2 rounded-xl px-2 py-1 text-[13px]",
                  !isActiveRemote && "text-muted-foreground",
                )}
                onClick={() => {
                  if (isActiveRemote) {
                    return;
                  }
                  toastManager.add({
                    type: "info",
                    title: "Open a remote project first",
                    description:
                      "Select a project or thread from that device in the sidebar, then create a worktree from here.",
                  });
                }}
              >
                <EnvironmentMenuRowContent
                  icon={<MonitorIcon className="size-3.5" />}
                  label={isActiveRemote ? "Remote worktree" : environment.host.name}
                  meta={isActiveRemote ? <CheckIcon className="size-3.5" /> : null}
                />
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuGroup>
          <MenuItem
            className="min-h-9 items-center gap-2 rounded-xl px-2 py-1 text-[13px]"
            disabled={!props.canCreateNewWorktree && !props.onNewWorktreeRequest}
            onClick={() => {
              if (props.canCreateNewWorktree && !isExistingWorktree) {
                props.onEnvModeSelect("worktree");
                return;
              }
              props.onNewWorktreeRequest?.();
            }}
          >
            <EnvironmentMenuRowContent
              icon={<GitBranchPlusIcon className="size-3.5" />}
              label="New worktree"
              meta={isPendingNewWorktree ? <CheckIcon className="size-3.5" /> : null}
            />
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export default function BranchToolbar({
  threadId,
  currentBranchName,
  connectionUrl = null,
  onEnvModeChange,
  envModeOverride = null,
  envLocked,
  presentation = "footer",
  localEnvironmentLabel = LOCAL_ENVIRONMENT_LABEL,
  localEnvironmentIcon = null,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  onNewWorktreeRequest,
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
  const effectiveEnvMode =
    envModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const canCreateNewWorktree =
    !activeWorktreePath && (!serverThread || serverThread.messages.length === 0);
  const connectedRemoteEnvironments = useConnectedRemoteEnvironments();
  const normalizedConnectionUrl = useMemo(() => {
    if (!connectionUrl) {
      return null;
    }
    const localConnectionUrl = normalizeWsUrl(resolveLocalDeviceWsUrl());
    const nextConnectionUrl = normalizeWsUrl(connectionUrl);
    return nextConnectionUrl === localConnectionUrl ? null : nextConnectionUrl;
  }, [connectionUrl]);

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
  const isDraftPresentation = presentation === "draft";
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
          activeWorktreePath={activeWorktreePath}
          activeConnectionUrl={normalizedConnectionUrl}
          canCreateNewWorktree={canCreateNewWorktree}
          connectedRemoteEnvironments={connectedRemoteEnvironments}
          effectiveEnvMode={activeWorktreePath ? "worktree" : effectiveEnvMode}
          envLocked={envLocked}
          localEnvironmentIcon={localEnvironmentIcon}
          localEnvironmentLabel={localEnvironmentLabel}
          rowClassName={environmentModeRowClassName}
          onEnvModeSelect={handleEnvModeSelect}
          {...(onNewWorktreeRequest ? { onNewWorktreeRequest } : {})}
        />

        <BranchToolbarBranchSelector
          activeProjectCwd={activeProject.cwd}
          activeThreadBranch={activeThreadBranch}
          activeWorktreePath={activeWorktreePath}
          branchCwd={branchCwd}
          connectionUrl={normalizedConnectionUrl}
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

  if (isDraftPresentation) {
    return (
      <BranchToolbarBranchSelector
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={activeWorktreePath}
        branchCwd={branchCwd}
        connectionUrl={normalizedConnectionUrl}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        presentation="draft"
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
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
                <GitBranchPlusIcon className="size-3 opacity-60" />
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
                  <GitBranchPlusIcon className="size-3" />
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
        connectionUrl={normalizedConnectionUrl}
        effectiveEnvMode={effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
