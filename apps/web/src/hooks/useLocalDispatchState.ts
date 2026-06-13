import { type ApprovalRequestId } from "@ace/contracts";
import { useMemo, useState } from "react";
import { type SessionPhase, type Thread } from "../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../lib/chat/chatView";

export function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const resetLocalDispatch = () => {
    setLocalDispatch(null);
  };

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  const beginLocalDispatch = (options?: { preparingWorktree?: boolean }) => {
    const preparingWorktree = Boolean(options?.preparingWorktree);
    setLocalDispatch((current) => {
      if (current && !serverAcknowledgedLocalDispatch) {
        return current.preparingWorktree === preparingWorktree
          ? current
          : { ...current, preparingWorktree };
      }
      return createLocalDispatchSnapshot(input.activeThread, options);
    });
  };

  const visibleLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  const activeThreadLocalDispatch =
    visibleLocalDispatch?.threadId === (input.activeThread?.id ?? null)
      ? visibleLocalDispatch
      : null;

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeThreadLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeThreadLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeThreadLocalDispatch !== null,
  };
}
