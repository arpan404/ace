import { useClient } from "@ace/client-react";
import {
  ArrowsClockwiseIcon,
  GitBranchIcon,
  LockOpenIcon,
  WarningCircleIcon,
  XIcon,
} from "@ace/icons";
import { staleLockOutcome } from "@ace/ui-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { AmendDialog } from "./amend-dialog.tsx";
import { BranchBar } from "./branch-bar.tsx";
import { CommitBox } from "./commit-box.tsx";
import { DiscardDialog, type DiscardRequest } from "./discard-dialog.tsx";
import { FileSection } from "./file-section.tsx";
import {
  emptySelection,
  pruneSelection,
  selectRow,
  type SelectionState,
  type SourceControlItem,
  type SourceControlSection,
} from "./source-control-model.ts";
import {
  cancelCommitDraft,
  clearStaleGitLock,
  commitChanges,
  createBranch,
  discardFiles,
  fetchRemote,
  generateCommitDraft,
  pullBranch,
  pushChanges,
  sourceControlErrorCode,
  sourceControlErrorText,
  stageFiles,
  stashPop,
  stashPush,
  switchBranch,
  unstageFiles,
} from "./source-control-source.ts";
import { useSourceControl } from "./use-source-control.ts";

type CommitMode = "commit" | "commit-and-push" | "amend";

export interface OpenChangesRequest {
  readonly path: string;
  readonly stage: "staged" | "unstaged";
  readonly oldPath?: string | undefined;
}

/**
 * The Editor explorer's Source control view: branch picker + sync + stash bar, commit box with
 * Write message and Commit/Amend/Commit and push, and Merge conflicts / Staged changes / Changes
 * sections. Shares the explorer's surface and portals its Refresh action into `ExplorerHeader`.
 */
export function SourceControlView(props: {
  threadId: string;
  actionsIn: HTMLElement | null;
  onOpenFile(path: string): void;
  onOpenChanges(request: OpenChangesRequest): void;
}) {
  const { threadId } = props;
  const client = useClient();
  const toast = useToast();
  const sc = useSourceControl(threadId);

  const [message, setMessage] = useState("");
  const [draftFingerprint, setDraftFingerprint] = useState<string | undefined>(undefined);
  const [drafting, setDrafting] = useState(false);
  const draftRef = useRef<{ id: string; controller: AbortController } | undefined>(undefined);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  const [selections, setSelections] = useState<Record<SourceControlSection, SelectionState>>({
    conflicts: emptySelection,
    staged: emptySelection,
    changes: emptySelection,
  });

  const [discardRequest, setDiscardRequest] = useState<DiscardRequest | undefined>(undefined);
  const [amendAsk, setAmendAsk] = useState<string | undefined>(undefined);
  const [clearingLock, setClearingLock] = useState(false);

  // Cancel any in-flight commit message generation when switching threads or unmounting.
  useEffect(() => {
    return () => {
      const active = draftRef.current;
      if (!active) return;
      draftRef.current = undefined;
      active.controller.abort();
      void cancelCommitDraft(client, threadId, active.id);
    };
  }, [client, threadId]);

  const conflictPaths = useMemo(
    () => sc.sections.conflicts.map((item) => item.path),
    [sc.sections.conflicts],
  );
  const stagedPaths = useMemo(
    () => sc.sections.staged.map((item) => item.path),
    [sc.sections.staged],
  );
  const changePaths = useMemo(
    () => sc.sections.changes.map((item) => item.path),
    [sc.sections.changes],
  );

  const effectiveSelections = useMemo(
    () => ({
      conflicts: pruneSelection(selections.conflicts, conflictPaths),
      staged: pruneSelection(selections.staged, stagedPaths),
      changes: pruneSelection(selections.changes, changePaths),
    }),
    [selections, conflictPaths, stagedPaths, changePaths],
  );

  const handleSelect = (
    section: SourceControlSection,
    ordered: readonly string[],
    path: string,
    modifiers: { meta: boolean; ctrl: boolean; shift: boolean },
    item: SourceControlItem,
  ) => {
    setSelections((was) => ({
      conflicts:
        section === "conflicts"
          ? selectRow(was.conflicts, ordered, path, modifiers)
          : emptySelection,
      staged:
        section === "staged" ? selectRow(was.staged, ordered, path, modifiers) : emptySelection,
      changes:
        section === "changes" ? selectRow(was.changes, ordered, path, modifiers) : emptySelection,
    }));
    if (!modifiers.meta && !modifiers.ctrl && !modifiers.shift) {
      props.onOpenChanges({
        path: item.path,
        stage: section === "staged" ? "staged" : "unstaged",
        oldPath: item.oldPath,
      });
    }
  };

  const handleWriteMessage = async () => {
    if (draftRef.current || !sc.online) return;
    const paths = sc.sections.staged.length > 0 ? stagedPaths : changePaths;
    if (paths.length === 0) return;
    const generationId = crypto.randomUUID();
    const controller = new AbortController();
    const active = { id: generationId, controller };
    draftRef.current = active;
    setDrafting(true);
    setDraftError(undefined);
    try {
      const { draft, context } = await generateCommitDraft(
        client,
        threadId,
        {
          generationId,
          selection: {
            kind: "commit",
            paths,
          },
        },
        controller.signal,
      );
      if (draftRef.current !== active) return;
      const body = draft.body.trim();
      setMessage(body ? `${draft.subject}\n\n${body}` : draft.subject);
      setDraftFingerprint(context.fingerprint);
    } catch (error) {
      if (draftRef.current === active && sourceControlErrorCode(error) !== "draft_cancelled") {
        setDraftError(sourceControlErrorText(error));
      }
    } finally {
      if (draftRef.current === active) {
        draftRef.current = undefined;
        setDrafting(false);
      }
    }
  };

  const handleCancelDraft = () => {
    const active = draftRef.current;
    if (!active) return;
    draftRef.current = undefined;
    setDrafting(false);
    active.controller.abort();
    void cancelCommitDraft(client, threadId, active.id);
  };

  const handleCommit = async (mode: CommitMode, confirmed = false) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    // Amending a commit the remote already has rewrites published history: ask first.
    if (mode === "amend" && !confirmed && sc.status?.upstream && sc.ahead === 0) {
      setAmendAsk(sc.status.upstream);
      return;
    }
    const stagedOnly = sc.sections.staged.length > 0;
    const committed = await sc.runAction("commit", () =>
      commitChanges(client, threadId, {
        message: trimmed,
        expectedHead: sc.head,
        // Bound to what the person reviewed: the index as read, or exactly the changes shown.
        expectedIndex: sc.status?.index,
        paths: stagedOnly
          ? undefined
          : sc.sections.changes.flatMap((item) =>
              item.oldPath ? [item.path, item.oldPath] : [item.path],
            ),
        stagedOnly,
        amend: mode === "amend",
        draftFingerprint,
      }),
    );
    if (!committed) return;
    // The commit landed: its message is spent even if the push below fails.
    setMessage("");
    setDraftFingerprint(undefined);
    setDraftError(undefined);
    if (mode === "commit-and-push") {
      const pushed = await sc.runAction("push", async () => {
        await pushChanges(client, threadId);
        return true;
      });
      if (pushed) toast.add({ title: "Committed and pushed" });
      return;
    }
    toast.add({ title: mode === "amend" ? "Amended last commit" : "Committed changes" });
  };

  const handleConfirmDiscard = async () => {
    const request = discardRequest;
    if (!request) return;
    setDiscardRequest(undefined);
    // Exactly the files the dialog named, as they were then: a file changed since is refused.
    await sc.runAction("discard", () => discardFiles(client, threadId, request.items));
  };

  const handleClearLock = async () => {
    setClearingLock(true);
    try {
      const result = await clearStaleGitLock(client, threadId);
      const outcome = staleLockOutcome(result, { threadId });
      if (outcome.ok) {
        toast.add({ title: outcome.title, description: outcome.detail });
        sc.clearActionError();
        await sc.refresh();
      } else {
        toast.error({ title: outcome.title, description: outcome.detail });
      }
    } finally {
      setClearingLock(false);
    }
  };

  const discardAgentPaths = useMemo(() => {
    if (!discardRequest) return [];
    return discardRequest.items
      .map((item) => item.path)
      .filter((path) => sc.agentTurnPaths.has(path));
  }, [discardRequest, sc.agentTurnPaths]);

  const headerActions = props.actionsIn
    ? createPortal(
        <IconButton
          icon={ArrowsClockwiseIcon}
          label="Refresh source control"
          tip="Refresh"
          disabled={!sc.online}
          onClick={() => void sc.refresh()}
          className={cn(
            "size-7 rounded-sm hover:bg-hover",
            sc.statusRefreshing && "[&_svg]:animate-spin",
          )}
        />,
        props.actionsIn,
      )
    : null;

  const isNotRepo = sc.statusErrorCode === "git_not_a_repo";
  const bannerError =
    sc.actionError ?? (draftError ? { code: undefined, message: draftError } : undefined);

  return (
    <div data-part="source-control-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {headerActions}

      {isNotRepo ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={GitBranchIcon}
            title="Not a Git repository"
            description="Open a project with a Git repository to track and commit changes."
          />
        </div>
      ) : (
        <>
          <BranchBar
            branch={sc.branch}
            ahead={sc.ahead}
            behind={sc.behind}
            branches={sc.branches}
            branchesLoading={sc.branchesLoading}
            stashes={sc.stashes}
            stashesLoading={sc.stashesLoading}
            disabled={!sc.online}
            agentWorking={sc.agentWorking}
            pendingAction={sc.pendingAction}
            onOpenBranches={sc.refetchBranches}
            onOpenStashes={sc.refetchStashes}
            onSwitchBranch={(branch, remote) =>
              void sc.runAction("branch", () => switchBranch(client, threadId, branch, remote))
            }
            onCreateBranch={(name) =>
              void sc.runAction("branch", () => createBranch(client, threadId, name))
            }
            onPull={() => void sc.runAction("pull", () => pullBranch(client, threadId))}
            onPush={() =>
              void sc
                .runAction("push", () => pushChanges(client, threadId))
                .then((res) => res && toast.add({ title: "Pushed branch" }))
            }
            onFetch={() => void sc.runAction("fetch", () => fetchRemote(client, threadId))}
            onStash={(includeUntracked) =>
              void sc
                .runAction("stash", () => stashPush(client, threadId, { includeUntracked }))
                .then((res) => res && toast.add({ title: "Stashed changes" }))
            }
            onPopStash={(ref) =>
              void sc
                .runAction("stash-pop", () => stashPop(client, threadId, ref))
                .then((res) => res && toast.add({ title: "Popped stash" }))
            }
          />

          <CommitBox
            message={message}
            onMessageChange={(next) => {
              setMessage(next);
              setDraftFingerprint(undefined);
            }}
            stagedCount={sc.sections.staged.length}
            changesCount={sc.sections.changes.length}
            conflictsCount={sc.sections.conflicts.length}
            disabled={!sc.online}
            committing={sc.pendingAction === "commit"}
            otherActionPending={sc.pendingAction !== undefined && sc.pendingAction !== "commit"}
            drafting={drafting}
            onWriteMessage={() => void handleWriteMessage()}
            onCancelDraft={handleCancelDraft}
            onCommit={(mode) => void handleCommit(mode)}
          />

          {bannerError && (
            <div
              role="alert"
              className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-status-failed/8 px-2.5 py-2 text-xs leading-4 text-foreground"
            >
              <div className="flex items-start gap-1.5">
                <Icon
                  icon={WarningCircleIcon}
                  size={14}
                  className="mt-0.5 shrink-0 text-status-failed"
                />
                <span className="min-w-0 flex-1">{bannerError.message}</span>
                <IconButton
                  icon={XIcon}
                  label="Dismiss error"
                  size="sm"
                  onClick={() => {
                    sc.clearActionError();
                    setDraftError(undefined);
                  }}
                  className="size-5 rounded-sm hover:bg-hover"
                />
              </div>
              {bannerError.code === "git_quarantined" && (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={clearingLock}
                    onClick={() => void handleClearLock()}
                  >
                    <Icon icon={LockOpenIcon} size={12} />
                    Clear stale lock
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain py-1">
            {sc.statusLoading ? (
              <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
                Reading Git status…
              </p>
            ) : sc.statusError ? (
              <div className="flex flex-col gap-2 px-3 py-3 text-xs text-muted-foreground">
                <p role="alert">{sc.statusError}</p>
                <div className="flex items-center gap-2">
                  <Button size="xs" variant="secondary" onClick={() => void sc.refresh()}>
                    Try again
                  </Button>
                  {sc.statusErrorCode === "git_quarantined" && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={clearingLock}
                      onClick={() => void handleClearLock()}
                    >
                      <Icon icon={LockOpenIcon} size={12} />
                      Clear stale lock
                    </Button>
                  )}
                </div>
              </div>
            ) : sc.sections.totalCount === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No changes in this checkout.
              </div>
            ) : (
              <>
                {sc.sections.conflicts.length > 0 && (
                  <FileSection
                    section="conflicts"
                    title="Merge conflicts"
                    items={sc.sections.conflicts}
                    selected={effectiveSelections.conflicts.selected}
                    disabled={!sc.online || sc.pendingAction !== undefined}
                    onSelect={(path, mods, item) =>
                      handleSelect("conflicts", conflictPaths, path, mods, item)
                    }
                    onOpenFile={props.onOpenFile}
                    onOpenChanges={(item) =>
                      props.onOpenChanges({
                        path: item.path,
                        stage: "unstaged",
                        oldPath: item.oldPath,
                      })
                    }
                    onStage={(paths) =>
                      void sc.runAction("stage", () => stageFiles(client, threadId, paths))
                    }
                    onStageAll={() =>
                      void sc.runAction("stage", () => stageFiles(client, threadId, conflictPaths))
                    }
                  />
                )}

                {sc.sections.staged.length > 0 && (
                  <FileSection
                    section="staged"
                    title="Staged changes"
                    items={sc.sections.staged}
                    selected={effectiveSelections.staged.selected}
                    disabled={!sc.online || sc.pendingAction !== undefined}
                    onSelect={(path, mods, item) =>
                      handleSelect("staged", stagedPaths, path, mods, item)
                    }
                    onOpenFile={props.onOpenFile}
                    onOpenChanges={(item) =>
                      props.onOpenChanges({
                        path: item.path,
                        stage: "staged",
                        oldPath: item.oldPath,
                      })
                    }
                    onUnstage={(paths) =>
                      void sc.runAction("unstage", () => unstageFiles(client, threadId, paths))
                    }
                    onUnstageAll={() =>
                      void sc.runAction("unstage", () => unstageFiles(client, threadId))
                    }
                  />
                )}

                {sc.sections.changes.length > 0 && (
                  <FileSection
                    section="changes"
                    title="Changes"
                    items={sc.sections.changes}
                    selected={effectiveSelections.changes.selected}
                    disabled={!sc.online || sc.pendingAction !== undefined}
                    onSelect={(path, mods, item) =>
                      handleSelect("changes", changePaths, path, mods, item)
                    }
                    onOpenFile={props.onOpenFile}
                    onOpenChanges={(item) =>
                      props.onOpenChanges({
                        path: item.path,
                        stage: "unstaged",
                        oldPath: item.oldPath,
                      })
                    }
                    onStage={(paths) =>
                      void sc.runAction("stage", () => stageFiles(client, threadId, paths))
                    }
                    onStageAll={() =>
                      void sc.runAction("stage", () => stageFiles(client, threadId))
                    }
                    discardWait={sc.agentWorking ? "Wait for the agent to finish" : undefined}
                    onDiscard={(items) => setDiscardRequest({ items, all: false })}
                    onDiscardAll={() =>
                      setDiscardRequest({ items: sc.sections.changes, all: true })
                    }
                  />
                )}
              </>
            )}
          </div>
        </>
      )}

      {amendAsk && (
        <AmendDialog
          upstream={amendAsk}
          onCancel={() => setAmendAsk(undefined)}
          onConfirm={() => {
            setAmendAsk(undefined);
            void handleCommit("amend", true);
          }}
        />
      )}

      {discardRequest && (
        <DiscardDialog
          key={`${discardRequest.all}:${discardRequest.items.map((item) => item.path).join(",")}`}
          request={discardRequest}
          agentEditedPaths={discardAgentPaths}
          busy={sc.pendingAction === "discard"}
          onCancel={() => setDiscardRequest(undefined)}
          onConfirm={() => void handleConfirmDiscard()}
        />
      )}
    </div>
  );
}
