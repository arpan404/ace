import {
  type ApprovalRequestId,
  type ClientOrchestrationCommand,
  type CommandId,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  TrimmedNonEmptyString,
} from "@ace/contracts";
import { truncate } from "@ace/shared/String";
import { type FormEvent, useCallback } from "react";
import { reportBackgroundError } from "~/lib/async";
import {
  buildExpiredTerminalContextToastCopy,
  cloneComposerImageForRetry,
  DEFAULT_THREAD_TITLE,
  deriveComposerSendState,
  deriveQueuedComposerMessageDraftForEditing,
  formatOutgoingPrompt,
  queuedComposerImageToDraftAttachment,
  readFileAsDataUrl,
} from "~/lib/chat/chatView";
import {
  buildAccumulatedCommentsPrompt,
  mergePendingCommentImages,
  type PendingComposerComment,
} from "~/lib/chat/commentAccumulation";
import { type RightSidePanelMode } from "~/lib/rightSidePanelState";
import {
  appendTerminalContextsToPrompt,
  deriveDisplayedUserMessageState,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { newCommandId, newMessageId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { stripComposerInlineMarkers } from "../../composer-editor-mentions";
import {
  parseProviderComposerSlashCommand,
  parseStandaloneComposerSlashCommand,
} from "../../composer-logic";
import {
  type ComposerImageAttachment,
  deriveEffectiveComposerExecutionModeState,
  type DraftThreadEnvMode,
  getComposerThreadDraft,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { getProviderModels } from "../../providerModels";
import type { ChatMessage, QueuedComposerImageAttachment, QueuedSteerRequest } from "../../types";
import { toastManager } from "../ui/toast";
import { EMPTY_PENDING_COMPOSER_COMMENTS, IMAGE_ONLY_BOOTSTRAP_PROMPT } from "./chatViewConstants";
import { type QueuedComposerMessage, type QueuedComposerState } from "./chatViewTypes";
import {
  formatComposerDispatchFailureMessage,
  toQueuedComposerCommandMessage,
} from "./chatViewUtils";
import { getComposerProviderState } from "./composerProviderRegistry";

export interface UseChatViewComposerActionsInput {
  threadId: ThreadId;
  activeThread:
    | {
        id: ThreadId;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
        messages: ReadonlyArray<ChatMessage>;
        modelSelection: ModelSelection;
        branch: string | null;
        worktreePath: string | null;
        title: string;
        createdAt: string;
        session: {
          provider: string;
          commands?: unknown[];
          status?: string;
          activeTurnId?: string;
        } | null;
      }
    | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  liveTurnInProgress: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  sendInFlight: boolean;
  activeProject:
    | {
        id: ProjectId;
        cwd: string;
        defaultModelSelection?: ModelSelection;
        scripts: unknown[];
      }
    | undefined;
  activeProjectId: string | undefined;
  gitCwd: string | null;
  isGitRepo: boolean;
  envMode: DraftThreadEnvMode;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  providerStatuses: ServerProvider[];
  modelSettings: {
    providers: Record<string, { instances: unknown[] }>;
  };
  composerProviderCommands: {
    name: string;
    promptPrefix?: string;
    kind?: "provider" | "skill" | "plugin";
  }[];
  composerModelOptions: unknown;
  selectedProvider: string;
  selectedProviderModels: unknown[];
  selectedModel: string;
  activeProposedPlan: { id: string; planMarkdown: string } | null;
  showPlanFollowUpPrompt: boolean;
  workLogEntries: unknown[];
  queryClient: unknown;
  optimisticQueuedDispatchMessageId: string | null;
  queuedComposerMessages: QueuedComposerMessage[];
  queuedSteerRequest: QueuedSteerRequest | null;
  optimisticQueuedComposerStateRef: React.MutableRefObject<QueuedComposerState | null>;
  composerImagesRef: React.MutableRefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.MutableRefObject<TerminalContextDraft[]>;
  promptRef: React.MutableRefObject<string>;
  sendInFlightRef: React.MutableRefObject<boolean>;
  queuedDesignMessageEditRef: React.MutableRefObject<QueuedComposerMessage | null>;
  queuedComposerMessagesRef: React.MutableRefObject<QueuedComposerMessage[]>;
  queuedSteerRequestRef: React.MutableRefObject<QueuedSteerRequest | null>;
  composerPanelsRef: React.MutableRefObject<{
    focusAtEnd: () => boolean;
    resetUi: (prompt?: string) => void;
    readSnapshot: () => {
      value: string;
      cursor: number;
      expandedCursor: number;
      terminalContextIds: string[];
    } | null;
    focusAt: (position: number) => void;
  } | null>;
  setThreadError: (targetThreadId: ThreadId, error: string | null) => void;
  forceStickToBottom: () => void;
  scheduleComposerFocus: () => void;
  setThreadOptimisticUserMessages: (
    targetThreadId: ThreadId,
    updater: (existing: readonly ChatMessage[]) => readonly ChatMessage[],
  ) => void;
  setOptimisticQueuedDispatchState: React.Dispatch<
    React.SetStateAction<{ threadId: ThreadId; messageId: MessageId } | null>
  >;
  pendingComposerCommentsByThreadId: Record<ThreadId, PendingComposerComment[]>;
  setPendingComposerCommentsByThreadId: (
    pendingComposerCommentsByThreadId:
      | Record<ThreadId, PendingComposerComment[]>
      | ((
          current: Record<ThreadId, PendingComposerComment[]>,
        ) => Record<ThreadId, PendingComposerComment[]>),
  ) => void;
  setThreadEnvModeOverrideById: React.Dispatch<
    React.SetStateAction<Partial<Record<ThreadId, DraftThreadEnvMode>>>
  >;
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
  setSendInFlightState: (value: boolean) => void;
  applyOptimisticQueuedComposerState: (
    targetThreadId: ThreadId,
    updater: (state: QueuedComposerState) => QueuedComposerState,
  ) => QueuedComposerState | null;
  restoreOptimisticQueuedComposerState: (state: QueuedComposerState | null) => void;
  setStickyComposerModelSelection: (selection: ModelSelection) => void;
  setComposerDraftModelSelection: (threadId: ThreadId, selection: ModelSelection) => void;
  setComposerDraftRuntimeMode: (threadId: ThreadId, mode: RuntimeMode) => void;
  setComposerDraftInteractionMode: (threadId: ThreadId, mode: ProviderInteractionMode) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    context: Partial<{
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
      envMode: DraftThreadEnvMode;
    }>,
  ) => void;
  activePendingProgress: { isLastQuestion: boolean; questionIndex: number } | null;
  activePendingUserInput: { requestId: ApprovalRequestId } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  rightSidePanelEnabled: boolean;
  setRightSidePanelMode: (
    mode:
      | RightSidePanelMode
      | null
      | ((previous: RightSidePanelMode | null) => RightSidePanelMode | null),
  ) => void;
  setRightSidePanelVisible: (visible: boolean) => void;
}

export interface UseChatViewComposerActionsOutput {
  setPrompt: (prompt: string) => void;
  addComposerImagesToDraft: (images: ComposerImageAttachment[]) => void;
  addComposerTerminalContextsToDraft: (contexts: TerminalContextDraft[]) => void;
  onSend: (event?: FormEvent<HTMLFormElement>) => Promise<void>;
  handleComposerSubmit: (event: FormEvent<HTMLFormElement>) => void;
  queueCurrentComposerMessage: (mode?: "queue" | "steer") => Promise<boolean>;
  handleQueueComposerMessage: () => void;
  onEditQueuedComposerMessage: (messageId: MessageId) => Promise<void>;
  onSteerQueuedComposerMessage: (messageId: MessageId) => Promise<void>;
  handleSubagentComposerSubmit: (
    event: FormEvent<HTMLFormElement>,
    subagent: { id: string },
  ) => Promise<void>;
  canSendQueuedComposerMessages: boolean;
  readCurrentComposerExecutionModeState: () => {
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  };
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  toggleInteractionMode: () => void;
  submitWorkspaceAgentNote: (input: {
    mode: "queue" | "send";
    prompt: string;
    threadId?: ThreadId;
  }) => Promise<boolean>;
  dismissPendingComposerComment: (commentId: string) => void;
  clearPendingComposerComments: () => void;
  pendingComposerComments: readonly PendingComposerComment[];
  queuePreparedMessage: (
    prompt: string,
    images: ReadonlyArray<ComposerImageAttachment>,
    options?: { targetThreadId?: ThreadId },
  ) => Promise<boolean>;
  removeQueuedComposerMessage: (messageId: MessageId) => Promise<boolean>;
  clearQueuedComposerMessages: () => Promise<boolean>;
  reorderQueuedComposerMessages: (draggedMessageId: MessageId, targetMessageId: MessageId) => void;
  dispatchQueuedComposerMessage: (
    targetThreadId: ThreadId,
    messageId: MessageId,
  ) => Promise<boolean>;
  ensureQueuedComposerThread: (options: {
    titleSeed: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<ThreadId | null>;
  appendQueuedComposerMessage: (
    targetThreadId: ThreadId,
    message: QueuedComposerMessage,
  ) => Promise<boolean>;
}

export function useChatViewComposerActions(
  input: UseChatViewComposerActionsInput,
): UseChatViewComposerActionsOutput {
  const {
    threadId,
    activeThread,
    isServerThread,
    isLocalDraftThread,
    liveTurnInProgress,
    isSendBusy,
    isConnecting,
    sendInFlight,
    activeProject,
    selectedModelSelection,
    runtimeMode,
    interactionMode,
    providerStatuses,
    composerProviderCommands,
    activeProposedPlan,
    showPlanFollowUpPrompt,
    workLogEntries,
    optimisticQueuedDispatchMessageId,
    queuedComposerMessages,
    composerImagesRef,
    composerTerminalContextsRef,
    promptRef,
    sendInFlightRef,
    queuedDesignMessageEditRef,
    queuedComposerMessagesRef,
    queuedSteerRequestRef,
    composerPanelsRef,
    setThreadError,
    forceStickToBottom,
    scheduleComposerFocus,
    setThreadOptimisticUserMessages,
    pendingComposerCommentsByThreadId,
    setPendingComposerCommentsByThreadId,
    beginLocalDispatch,
    resetLocalDispatch,
    setSendInFlightState,
    applyOptimisticQueuedComposerState,
    restoreOptimisticQueuedComposerState,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setDraftThreadContext,
    activePendingProgress,
    activePendingUserInput,
    activePendingResolvedAnswers,
  } = input;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);

  const setPrompt = (nextPrompt: string) => {
    setComposerDraftPrompt(threadId, nextPrompt);
  };
  const addComposerImagesToDraft = (images: ComposerImageAttachment[]) => {
    useComposerDraftStore.getState().addImages(threadId, images);
  };
  const addComposerTerminalContextsToDraft = (contexts: TerminalContextDraft[]) => {
    useComposerDraftStore.getState().addTerminalContexts(threadId, contexts);
  };

  const pendingComposerComments =
    pendingComposerCommentsByThreadId[threadId] ?? EMPTY_PENDING_COMPOSER_COMMENTS;

  const dismissPendingComposerComment = (commentId: string) => {
    setPendingComposerCommentsByThreadId((current) => {
      const existing = current[threadId] ?? [];
      const next = existing.filter((comment) => comment.id !== commentId);
      if (next.length === existing.length) {
        return current;
      }
      return {
        ...current,
        [threadId]: next,
      };
    });
  };
  const clearPendingComposerComments = () => {
    setPendingComposerCommentsByThreadId((current) => {
      if ((current[threadId] ?? []).length === 0) {
        return current;
      }
      return {
        ...current,
        [threadId]: [],
      };
    });
  };

  const dispatchQueuedComposerCommand = async (
    targetThreadId: ThreadId,
    buildCommand: (input: {
      commandId: CommandId;
      threadId: ThreadId;
    }) => ClientOrchestrationCommand,
  ) => {
    const api = readNativeApi();
    if (!api) {
      return false;
    }
    try {
      await api.orchestration.dispatchCommand(
        buildCommand({
          commandId: newCommandId(),
          threadId: targetThreadId,
        }),
      );
      return true;
    } catch (error) {
      setThreadError(
        targetThreadId,
        error instanceof Error ? error.message : "Failed to update queued messages.",
      );
      return false;
    }
  };

  const appendQueuedComposerMessage = async (
    targetThreadId: ThreadId,
    message: QueuedComposerMessage,
    options?: { steerRequest?: QueuedSteerRequest },
  ) => {
    const previousQueueState = applyOptimisticQueuedComposerState(targetThreadId, (state) => {
      const withoutDuplicate = state.messages.filter(
        (queuedMessage) => queuedMessage.id !== message.id,
      );
      const messages = options?.steerRequest
        ? [message, ...withoutDuplicate]
        : [...withoutDuplicate, message];
      return {
        ...state,
        messages,
        steerRequest:
          options?.steerRequest !== undefined ? options.steerRequest : state.steerRequest,
      };
    });
    const succeeded = await dispatchQueuedComposerCommand(
      targetThreadId,
      ({ commandId, threadId }) => ({
        type: "thread.queue.append" as const,
        commandId,
        threadId,
        message: toQueuedComposerCommandMessage(message),
        position: options?.steerRequest ? ("front" as const) : ("back" as const),
        ...(options?.steerRequest ? { steerRequest: options.steerRequest } : {}),
      }),
    );
    if (!succeeded) {
      restoreOptimisticQueuedComposerState(previousQueueState);
    }
    return succeeded;
  };

  const deleteQueuedComposerMessage = async (targetThreadId: ThreadId, messageId: MessageId) => {
    const previousQueueState = applyOptimisticQueuedComposerState(targetThreadId, (state) => ({
      ...state,
      messages: state.messages.filter((message) => message.id !== messageId),
      steerRequest: state.steerRequest?.messageId === messageId ? null : state.steerRequest,
    }));
    const succeeded = await dispatchQueuedComposerCommand(
      targetThreadId,
      ({ commandId, threadId }) => ({
        type: "thread.queue.delete" as const,
        commandId,
        threadId,
        messageId,
      }),
    );
    if (!succeeded) {
      restoreOptimisticQueuedComposerState(previousQueueState);
    }
    return succeeded;
  };

  const clearQueuedSteerRequest = async (targetThreadId: ThreadId) => {
    const previousQueueState = applyOptimisticQueuedComposerState(targetThreadId, (state) => ({
      ...state,
      steerRequest: null,
    }));
    const succeeded = await dispatchQueuedComposerCommand(
      targetThreadId,
      ({ commandId, threadId }) => ({
        type: "thread.queue.steer.clear" as const,
        commandId,
        threadId,
      }),
    );
    if (!succeeded) {
      restoreOptimisticQueuedComposerState(previousQueueState);
    }
    return succeeded;
  };

  const steerQueuedComposerMessage = async (
    targetThreadId: ThreadId,
    messageId: MessageId,
    options: { baselineWorkLogEntryCount: number; interruptRequested?: boolean },
  ) => {
    const previousQueueState = applyOptimisticQueuedComposerState(targetThreadId, (state) => {
      const messageIndex = state.messages.findIndex((message) => message.id === messageId);
      if (messageIndex < 0) {
        return state;
      }
      const messages = [...state.messages];
      const [message] = messages.splice(messageIndex, 1);
      if (message) {
        messages.unshift(message);
      }
      return {
        ...state,
        messages,
        steerRequest: {
          messageId,
          baselineWorkLogEntryCount: options.baselineWorkLogEntryCount,
          interruptRequested: options.interruptRequested ?? false,
        },
      };
    });
    const succeeded = await dispatchQueuedComposerCommand(
      targetThreadId,
      ({ commandId, threadId }) => ({
        type: "thread.queue.steer" as const,
        commandId,
        threadId,
        messageId,
        baselineWorkLogEntryCount: options.baselineWorkLogEntryCount,
        interruptRequested: options.interruptRequested ?? false,
      }),
    );
    if (!succeeded) {
      restoreOptimisticQueuedComposerState(previousQueueState);
    }
    return succeeded;
  };

  const dispatchQueuedComposerMessage = async (targetThreadId: ThreadId, messageId: MessageId) =>
    await dispatchQueuedComposerCommand(targetThreadId, ({ commandId, threadId }) => ({
      type: "thread.queue.dispatch" as const,
      commandId,
      threadId,
      messageId,
    }));

  const buildQueuedComposerImages = async (
    images: ReadonlyArray<ComposerImageAttachment>,
  ): Promise<QueuedComposerImageAttachment[]> => {
    const persistedAttachmentById = new Map(
      getComposerThreadDraft(threadId).persistedAttachments.map(
        (attachment) => [attachment.id, attachment] as const,
      ),
    );
    return await Promise.all(
      images.map(async (image) => {
        const persistedAttachment = persistedAttachmentById.get(image.id);
        const dataUrl = persistedAttachment?.dataUrl ?? (await readFileAsDataUrl(image.file));
        return {
          type: "image" as const,
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl,
          previewUrl: image.previewUrl || dataUrl,
          file: image.file,
        };
      }),
    );
  };

  const ensureQueuedComposerThread = async (options: {
    titleSeed: string;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }): Promise<ThreadId | null> => {
    if (activeThread && isServerThread) {
      return activeThread.id;
    }
    const api = readNativeApi();
    if (!api || !activeProject) {
      return null;
    }
    const targetThreadId = activeThread?.id ?? threadId;
    const normalizedTitleSeed = options.titleSeed.trim().replace(/\s+/gu, " ");
    const title = truncate(
      normalizedTitleSeed.length > 0 ? normalizedTitleSeed : DEFAULT_THREAD_TITLE,
    );
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: targetThreadId,
        projectId: activeProject.id,
        title,
        modelSelection: options.modelSelection,
        runtimeMode: options.runtimeMode,
        interactionMode: options.interactionMode,
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
        createdAt: activeThread?.createdAt ?? new Date().toISOString(),
      });
    } catch (error) {
      reportBackgroundError("Failed to create a thread before queueing a composer message.", error);
    }
    return targetThreadId;
  };

  const restoreQueuedComposerMessageToDraft = (
    message: QueuedComposerMessage,
    restoredImages: ReadonlyArray<ComposerImageAttachment>,
  ) => {
    promptRef.current = message.prompt;
    setPrompt(message.prompt);
    addComposerImagesToDraft([...restoredImages]);
    useComposerDraftStore.getState().setTerminalContexts(
      threadId,
      message.terminalContexts.map((context) => ({ ...context, threadId })),
    );
    setComposerDraftModelSelection(threadId, message.modelSelection);
    setComposerDraftRuntimeMode(threadId, message.runtimeMode);
    setComposerDraftInteractionMode(threadId, message.interactionMode);
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, {
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
      });
    }
    composerPanelsRef.current?.resetUi(message.prompt);
    scheduleComposerFocus();
  };

  const onEditQueuedComposerMessage = async (messageId: MessageId) => {
    const nextMessage = queuedComposerMessagesRef.current.find(
      (message) => message.id === messageId,
    );
    if (!nextMessage) {
      return;
    }
    const messageDraft = deriveQueuedComposerMessageDraftForEditing(nextMessage);
    let restoredImages: ComposerImageAttachment[] = [];
    if (messageDraft.includeImages) {
      try {
        restoredImages = await Promise.all(
          nextMessage.images.map((image) => queuedComposerImageToDraftAttachment(image)),
        );
      } catch (error) {
        setThreadError(
          threadId,
          error instanceof Error ? error.message : "Failed to restore queued images.",
        );
        return;
      }
    }
    if (
      !activeThread ||
      !isServerThread ||
      !(await deleteQueuedComposerMessage(activeThread.id, messageId))
    ) {
      return;
    }
    queuedDesignMessageEditRef.current = messageDraft.includeImages ? null : nextMessage;
    restoreQueuedComposerMessageToDraft(
      {
        ...nextMessage,
        prompt: messageDraft.prompt,
        images: messageDraft.includeImages ? nextMessage.images : [],
        terminalContexts: messageDraft.includeTerminalContexts ? nextMessage.terminalContexts : [],
      },
      restoredImages,
    );
  };

  const queueCurrentComposerMessage = async (mode: "queue" | "steer" = "queue") => {
    const api = readNativeApi();
    if (!api || !activeThread || (sendInFlightRef.current && !isServerThread)) {
      return false;
    }
    const hiddenDesignMessage = queuedDesignMessageEditRef.current;
    const composerImages = composerImagesRef.current;
    const pendingCommentsForQueue = pendingComposerComments;
    const hasPendingComposerComments = pendingCommentsForQueue.length > 0;
    const promptForQueueWithoutInlineMarkers = stripComposerInlineMarkers(promptRef.current);
    const composerTerminalContexts = composerTerminalContextsRef.current;
    const { sendableTerminalContexts, expiredTerminalContextCount, hasSendableContent } =
      deriveComposerSendState({
        prompt: promptForQueueWithoutInlineMarkers,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      });
    if (!hasSendableContent && !hasPendingComposerComments) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return false;
    }

    let queuedImages: QueuedComposerImageAttachment[];
    try {
      queuedImages = await buildQueuedComposerImages(composerImages);
    } catch (error) {
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "Failed to queue message attachments.",
      );
      return false;
    }
    const providerSlashCommandPayload =
      composerImages.length === 0 && sendableTerminalContexts.length === 0
        ? parseProviderComposerSlashCommand(
            promptForQueueWithoutInlineMarkers.trim(),
            composerProviderCommands,
          )
        : null;
    const promptForQueueBase =
      providerSlashCommandPayload?.promptText ?? promptForQueueWithoutInlineMarkers;
    const promptForQueue =
      hiddenDesignMessage === null
        ? buildAccumulatedCommentsPrompt(promptForQueueBase, pendingCommentsForQueue)
        : buildAccumulatedCommentsPrompt(
            hiddenDesignMessage.prompt
              ? `${hiddenDesignMessage.prompt}\n\n${promptForQueueBase}`
              : promptForQueueBase,
            pendingCommentsForQueue,
          );
    const mergedQueuedImagesBeforeComments =
      hiddenDesignMessage === null
        ? queuedImages
        : [...hiddenDesignMessage.images, ...queuedImages].filter(
            (image, index, allImages) =>
              allImages.findIndex((candidate) => candidate.id === image.id) === index,
          );
    const mergedQueuedImages = mergePendingCommentImages(
      mergedQueuedImagesBeforeComments,
      pendingCommentsForQueue,
    );
    if (mergedQueuedImages.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      toastManager.add({
        type: "warning",
        title: "Too many screenshots",
        description: `Send at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images at a time.`,
      });
      return false;
    }
    const queuedTerminalContexts = sendableTerminalContexts.map((context) => ({
      id: context.id,
      createdAt: context.createdAt,
      terminalId: context.terminalId,
      terminalLabel: context.terminalLabel,
      lineStart: context.lineStart,
      lineEnd: context.lineEnd,
      text: context.text,
    }));
    const mergedQueuedTerminalContexts =
      hiddenDesignMessage === null
        ? queuedTerminalContexts
        : [...hiddenDesignMessage.terminalContexts, ...queuedTerminalContexts].filter(
            (context, index, allContexts) =>
              allContexts.findIndex((candidate) => candidate.id === context.id) === index,
          );
    const queuedMessage: QueuedComposerMessage = {
      id: newMessageId(),
      prompt: promptForQueue,
      images: mergedQueuedImages,
      terminalContexts: mergedQueuedTerminalContexts,
      modelSelection: selectedModelSelection,
      runtimeMode: activeThread.runtimeMode,
      interactionMode: activeThread.interactionMode,
    };
    const targetThreadId = await ensureQueuedComposerThread({
      titleSeed: promptForQueueBase || pendingCommentsForQueue[0]?.body || "Pending comments",
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
    });
    if (!targetThreadId) {
      return false;
    }
    const appendOptions =
      mode === "steer"
        ? {
            steerRequest: {
              messageId: queuedMessage.id,
              baselineWorkLogEntryCount: workLogEntries.length,
              interruptRequested: false,
            },
          }
        : undefined;
    if (!(await appendQueuedComposerMessage(targetThreadId, queuedMessage, appendOptions))) {
      return false;
    }

    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }

    promptRef.current = "";
    clearComposerDraftContent(threadId);
    queuedDesignMessageEditRef.current = null;
    if (hasPendingComposerComments) {
      setPendingComposerCommentsByThreadId((current) => ({
        ...current,
        [threadId]: [],
      }));
    }
    composerPanelsRef.current?.resetUi("");
    return true;
  };

  const onSteerQueuedComposerMessage = async (messageId: MessageId) => {
    const activeSteerRequest = queuedSteerRequestRef.current;
    if (activeSteerRequest?.messageId === messageId) {
      if (activeThread && isServerThread) {
        await clearQueuedSteerRequest(activeThread.id);
      }
      return;
    }
    if (activeSteerRequest) {
      return;
    }
    const nextMessage = queuedComposerMessagesRef.current.find(
      (message) => message.id === messageId,
    );
    if (!nextMessage) {
      return;
    }
    if (!activeThread || !isServerThread) {
      return;
    }
    await steerQueuedComposerMessage(activeThread.id, messageId, {
      baselineWorkLogEntryCount: workLogEntries.length,
      interruptRequested: false,
    });
  };

  const readCurrentComposerExecutionModeState = () =>
    deriveEffectiveComposerExecutionModeState({
      draft: getComposerThreadDraft(threadId),
      threadRuntimeMode: activeThread?.runtimeMode ?? null,
      threadInteractionMode: activeThread?.interactionMode ?? null,
    });

  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    const currentRuntimeMode = readCurrentComposerExecutionModeState().runtimeMode;
    if (mode === currentRuntimeMode) return;
    setComposerDraftRuntimeMode(threadId, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, { runtimeMode: mode });
    }
    scheduleComposerFocus();
  };

  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    const currentInteractionMode = readCurrentComposerExecutionModeState().interactionMode;
    if (mode === currentInteractionMode) return;
    setComposerDraftInteractionMode(threadId, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, { interactionMode: mode });
    }
    scheduleComposerFocus();
  };

  const toggleInteractionMode = () => {
    const currentInteractionMode = readCurrentComposerExecutionModeState().interactionMode;
    handleInteractionModeChange(currentInteractionMode === "plan" ? "default" : "plan");
  };

  const dispatchComposerMessage = async (
    submission: {
      prompt: string;
      images: Array<ComposerImageAttachment | QueuedComposerImageAttachment>;
      terminalContexts: TerminalContextDraft[];
      modelSelection: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    },
    options?: {
      onFailure?: () => void;
      restorePrompt?: string;
    },
  ) => {
    const api = readNativeApi();
    if (!api || !activeThread || sendInFlightRef.current) return false;
    if (!activeProject) return false;

    const promptForSend = stripComposerInlineMarkers(submission.prompt);
    const composerImagesSnapshot = [...submission.images];
    const composerTerminalContextsSnapshot = [...submission.terminalContexts];
    const threadIdForSend = activeThread.id;
    const submissionModelOptions = submission.modelSelection.options
      ? {
          [submission.modelSelection.provider]: submission.modelSelection.options,
        }
      : null;
    const submissionProviderModels = getProviderModels(
      providerStatuses,
      submission.modelSelection.provider,
      submission.modelSelection.providerInstanceId,
    );
    const submissionProviderState = getComposerProviderState({
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      models: submissionProviderModels,
      prompt: promptForSend,
      modelOptions: submissionModelOptions,
    });
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;

    const strippedPrompt = deriveDisplayedUserMessageState(promptForSend).visibleText.trim();
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      models: submissionProviderModels,
      effort: submissionProviderState.promptEffort,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const failureContext = {
      provider: submission.modelSelection.provider,
      model: submission.modelSelection.model,
      visiblePromptLength: strippedPrompt.length,
      outgoingPromptLength: outgoingMessageText.length,
      imageCount: composerImagesSnapshot.length,
      imageBytes: composerImagesSnapshot.reduce((total, image) => total + image.sizeBytes, 0),
      terminalContextCount: composerTerminalContextsSnapshot.length,
      terminalContextChars: composerTerminalContextsSnapshot.reduce(
        (total, context) => total + context.text.length,
        0,
      ),
    };
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: "dataUrl" in image ? image.dataUrl : await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));

    setSendInFlightState(true);
    beginLocalDispatch({ preparingWorktree: false });
    const optimisticUserMessage: ChatMessage = {
      id: messageIdForSend,
      role: "user",
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    };
    setThreadOptimisticUserMessages(threadIdForSend, (existing) => [
      ...existing,
      optimisticUserMessage,
    ]);
    forceStickToBottom();

    setThreadError(threadIdForSend, null);

    let turnStartSucceeded = false;
    await (async () => {
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title: truncate(strippedPrompt.length > 0 ? strippedPrompt : DEFAULT_THREAD_TITLE),
        });
      }

      beginLocalDispatch({ preparingWorktree: false });
      const turnAttachments = await turnAttachmentsPromise;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: submission.modelSelection,
        titleSeed: truncate(strippedPrompt.length > 0 ? strippedPrompt : DEFAULT_THREAD_TITLE),
        runtimeMode: submission.runtimeMode,
        interactionMode: submission.interactionMode,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      const promptForRestore = options?.restorePrompt ?? promptForSend;
      if (
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
      ) {
        setThreadOptimisticUserMessages(threadIdForSend, (existing) => {
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
        promptRef.current = promptForRestore;
        setPrompt(promptForRestore);
        addComposerImagesToDraft(
          composerImagesSnapshot.flatMap((image) =>
            "dataUrl" in image ? [] : [cloneComposerImageForRetry(image)],
          ),
        );
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        composerPanelsRef.current?.resetUi(promptForRestore);
      }
      options?.onFailure?.();
      setThreadError(threadIdForSend, formatComposerDispatchFailureMessage(err, failureContext));
    });
    setSendInFlightState(false);
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
    return turnStartSucceeded;
  };

  const onSend = async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread) return;
    if (activePendingProgress) {
      if (activePendingUserInput && activePendingResolvedAnswers) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.user-input.respond",
            commandId: newCommandId(),
            threadId: activeThread.id,
            requestId: activePendingUserInput.requestId,
            answers: activePendingResolvedAnswers,
            createdAt: new Date().toISOString(),
          })
          .catch((err: unknown) => {
            setThreadError(
              activeThread.id,
              err instanceof Error ? err.message : "Failed to submit user input.",
            );
          });
      }
      return;
    }
    if (liveTurnInProgress || isSendBusy || isConnecting) {
      await queueCurrentComposerMessage();
      return;
    }
    if (sendInFlightRef.current) return;
    const promptForSend = promptRef.current;
    const promptForSendWithoutInlineMarkers = stripComposerInlineMarkers(promptForSend);
    const composerImages = composerImagesRef.current;
    const pendingCommentsForSend = pendingComposerComments;
    const hasPendingComposerComments = pendingCommentsForSend.length > 0;
    const composerTerminalContexts = composerTerminalContextsRef.current;
    const hiddenDesignMessage = queuedDesignMessageEditRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSendWithoutInlineMarkers,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      composerPanelsRef.current?.resetUi("");
      return;
    }
    const providerSlashCommandPayload =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseProviderComposerSlashCommand(trimmed, composerProviderCommands)
        : null;
    const standaloneSlashCommand =
      providerSlashCommandPayload === null ? parseStandaloneComposerSlashCommand(trimmed) : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(activeThread.id);
      composerPanelsRef.current?.resetUi("");
      return;
    }
    if (!hasSendableContent && !hasPendingComposerComments) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    const promptForDispatchBase =
      providerSlashCommandPayload?.promptText ?? promptForSendWithoutInlineMarkers;
    const promptWithHiddenDesignContext =
      hiddenDesignMessage === null
        ? promptForDispatchBase
        : hiddenDesignMessage.prompt
          ? `${hiddenDesignMessage.prompt}\n\n${promptForDispatchBase}`
          : promptForDispatchBase;
    const promptWithPendingComments = buildAccumulatedCommentsPrompt(
      promptWithHiddenDesignContext,
      pendingCommentsForSend,
    );
    let imagesWithIssueContext: Array<ComposerImageAttachment | QueuedComposerImageAttachment> =
      hiddenDesignMessage === null
        ? composerImages
        : [...hiddenDesignMessage.images, ...composerImages].filter(
            (image, index, allImages) =>
              allImages.findIndex((candidate) => candidate.id === image.id) === index,
          );
    imagesWithIssueContext = mergePendingCommentImages(
      imagesWithIssueContext,
      pendingCommentsForSend,
    );
    if (imagesWithIssueContext.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      toastManager.add({
        type: "warning",
        title: "Too many screenshots",
        description: `Send at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images at a time.`,
      });
      return;
    }
    const terminalContextsForDispatch =
      hiddenDesignMessage === null
        ? sendableComposerTerminalContexts
        : [
            ...hiddenDesignMessage.terminalContexts.map((context) => ({
              ...context,
              threadId: activeThread.id,
            })),
            ...sendableComposerTerminalContexts,
          ].filter(
            (context, index, allContexts) =>
              allContexts.findIndex((candidate) => candidate.id === context.id) === index,
          );
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    promptRef.current = "";
    clearComposerDraftContent(activeThread.id);
    queuedDesignMessageEditRef.current = null;
    composerPanelsRef.current?.resetUi("");

    const dispatched = await dispatchComposerMessage(
      {
        prompt: promptWithPendingComments,
        images: imagesWithIssueContext,
        terminalContexts: terminalContextsForDispatch,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      },
      {
        restorePrompt: promptForSend,
        onFailure: () => {
          queuedDesignMessageEditRef.current = hiddenDesignMessage;
        },
      },
    );
    if (dispatched && hasPendingComposerComments) {
      setPendingComposerCommentsByThreadId((current) => ({
        ...current,
        [threadId]: [],
      }));
    }
  };

  const handleQueueComposerMessage = () => {
    queueCurrentComposerMessage(liveTurnInProgress ? "steer" : "queue");
  };

  const canSendQueuedComposerMessages =
    queuedComposerMessages.length > 0 &&
    optimisticQueuedDispatchMessageId === null &&
    !liveTurnInProgress &&
    !isSendBusy &&
    !isConnecting &&
    !sendInFlight;

  const handleSubagentComposerSubmit = async (
    event: FormEvent<HTMLFormElement>,
    subagent: { id: string },
  ) => {
    event.preventDefault();
    const api = readNativeApi();
    if (!api || !activeThread) return;
    const draftThreadId = ThreadId.makeUnsafe(`subagent:${activeThread.id}:${subagent.id}`);
    const draft = getComposerThreadDraft(draftThreadId);
    const promptForSend = draft.prompt;
    const promptForSendWithoutInlineMarkers = stripComposerInlineMarkers(promptForSend);
    const { sendableTerminalContexts, expiredTerminalContextCount, hasSendableContent } =
      deriveComposerSendState({
        prompt: promptForSendWithoutInlineMarkers,
        imageCount: draft.images.length,
        terminalContexts: draft.terminalContexts,
      });
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }

    const { interactionMode: subagentInteractionMode, runtimeMode: subagentRuntimeMode } =
      deriveEffectiveComposerExecutionModeState({
        draft,
        threadRuntimeMode: activeThread.runtimeMode,
        threadInteractionMode: activeThread.interactionMode,
      });
    const sideProviderInstanceId =
      draft.modelSelectionByProvider.codex?.providerInstanceId ??
      (activeThread.modelSelection.provider === "codex"
        ? activeThread.modelSelection.providerInstanceId
        : undefined);
    const sideProviderModels = getProviderModels(providerStatuses, "codex", sideProviderInstanceId);
    const sideProviderState = getComposerProviderState({
      provider: "codex",
      model: activeThread.modelSelection.model,
      models: sideProviderModels,
      prompt: promptForSendWithoutInlineMarkers,
      modelOptions: null,
    });
    const modelSelection: ModelSelection = {
      provider: "codex",
      model: activeThread.modelSelection.model,
      ...(sideProviderState.modelOptionsForDispatch
        ? { options: sideProviderState.modelOptionsForDispatch }
        : {}),
      ...(sideProviderInstanceId ? { providerInstanceId: sideProviderInstanceId } : {}),
    };
    const textWithTerminalContext = appendTerminalContextsToPrompt(
      promptForSendWithoutInlineMarkers,
      sendableTerminalContexts,
    );
    const outgoingMessageText = formatOutgoingPrompt({
      provider: "codex",
      model: activeThread.modelSelection.model,
      models: sideProviderModels,
      effort: sideProviderState.promptEffort,
      text: textWithTerminalContext,
    });
    let attachments: Array<{
      type: "image";
      name: string;
      mimeType: string;
      sizeBytes: number;
      dataUrl: string;
    }>;
    try {
      attachments = await Promise.all(
        draft.images.map(async (image) => ({
          type: "image" as const,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl:
            "dataUrl" in image && typeof image.dataUrl === "string"
              ? image.dataUrl
              : await readFileAsDataUrl(image.file),
        })),
      );
    } catch (error) {
      setThreadError(
        draftThreadId,
        error instanceof Error ? error.message : "Failed to read message attachments.",
      );
      return;
    }
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    const createdAt = new Date().toISOString();
    try {
      setThreadError(draftThreadId, null);
      await api.orchestration.dispatchCommand({
        type: "thread.subagent.turn.start",
        commandId: newCommandId(),
        threadId: activeThread.id,
        subagentThreadId: TrimmedNonEmptyString.makeUnsafe(subagent.id),
        message: {
          messageId: newMessageId(),
          role: "user",
          text: outgoingMessageText,
          attachments,
        },
        modelSelection,
        runtimeMode: subagentRuntimeMode,
        interactionMode: subagentInteractionMode,
        createdAt,
      });
      clearComposerDraftContent(draftThreadId);
    } catch (error) {
      setThreadError(
        draftThreadId,
        error instanceof Error ? error.message : "Failed to send subagent message.",
      );
    }
  };

  const handleComposerSubmit = (event: FormEvent<HTMLFormElement>) => {
    void onSend(event);
  };

  const submitWorkspaceAgentNote = async (input: {
    mode: "queue" | "send";
    prompt: string;
    threadId?: ThreadId;
  }): Promise<boolean> => {
    const trimmedPrompt = input.prompt.trim();
    if (trimmedPrompt.length === 0) {
      return false;
    }
    const activeComposerThreadId = activeThread?.id ?? threadId;
    const targetThreadId = input.threadId ?? activeComposerThreadId;
    if (input.mode === "queue") {
      const queuedImages = await buildQueuedComposerImages([]);
      const queuedMessage: QueuedComposerMessage = {
        id: newMessageId(),
        prompt: trimmedPrompt,
        images: queuedImages,
        terminalContexts: [],
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      };
      const effectiveTargetThreadId =
        targetThreadId === activeComposerThreadId
          ? await ensureQueuedComposerThread({
              titleSeed: trimmedPrompt,
              modelSelection: selectedModelSelection,
              runtimeMode,
              interactionMode,
            })
          : targetThreadId;
      if (!effectiveTargetThreadId) {
        return false;
      }
      return appendQueuedComposerMessage(effectiveTargetThreadId, queuedMessage);
    }
    if (targetThreadId !== activeComposerThreadId) {
      const queuedImages = await buildQueuedComposerImages([]);
      const queuedMessage: QueuedComposerMessage = {
        id: newMessageId(),
        prompt: trimmedPrompt,
        images: queuedImages,
        terminalContexts: [],
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
      };
      return appendQueuedComposerMessage(targetThreadId!, queuedMessage);
    }
    if (liveTurnInProgress || isSendBusy || isConnecting || sendInFlightRef.current) {
      return false;
    }
    return dispatchComposerMessage({
      prompt: trimmedPrompt,
      images: [],
      terminalContexts: [],
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
    });
  };

  const queuePreparedMessage = async (
    prompt: string,
    images: ReadonlyArray<ComposerImageAttachment>,
    options?: { targetThreadId?: ThreadId },
  ): Promise<boolean> => {
    const activeComposerThreadId = activeThread?.id ?? threadId;
    const targetThreadId = options?.targetThreadId ?? activeComposerThreadId;
    if (!activeThread) {
      return false;
    }
    const queuedImages = await buildQueuedComposerImages(images);
    const queuedMessage: QueuedComposerMessage = {
      id: newMessageId(),
      prompt,
      images: queuedImages,
      terminalContexts: [],
      modelSelection: selectedModelSelection,
      runtimeMode,
      interactionMode,
    };
    const effectiveTargetThreadId =
      targetThreadId === activeComposerThreadId
        ? await ensureQueuedComposerThread({
            titleSeed: prompt,
            modelSelection: selectedModelSelection,
            runtimeMode,
            interactionMode,
          })
        : targetThreadId;
    if (!effectiveTargetThreadId) {
      return false;
    }
    return appendQueuedComposerMessage(effectiveTargetThreadId, queuedMessage);
  };

  const removeQueuedComposerMessage = async (messageId: MessageId): Promise<boolean> => {
    if (!activeThread || !isServerThread) {
      return false;
    }
    return deleteQueuedComposerMessage(activeThread.id, messageId);
  };

  const clearQueuedComposerMessages = async (): Promise<boolean> => {
    if (!activeThread || !isServerThread) {
      return false;
    }
    const previousQueueState = applyOptimisticQueuedComposerState(activeThread.id, (state) => ({
      ...state,
      messages: [],
      steerRequest: null,
    }));
    const succeeded = await dispatchQueuedComposerCommand(
      activeThread.id,
      ({ commandId, threadId: targetThreadId }) => ({
        type: "thread.queue.clear" as const,
        commandId,
        threadId: targetThreadId,
      }),
    );
    if (!succeeded) {
      restoreOptimisticQueuedComposerState(previousQueueState);
    }
    return succeeded;
  };

  const reorderQueuedComposerMessages = (
    draggedMessageId: MessageId,
    targetMessageId: MessageId,
  ) => {
    if (!activeThread || !isServerThread) {
      return;
    }
    const messages = [...queuedComposerMessages];
    const draggedIndex = messages.findIndex((m) => m.id === draggedMessageId);
    const targetIndex = messages.findIndex((m) => m.id === targetMessageId);
    if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
      return;
    }
    const [moved] = messages.splice(draggedIndex, 1);
    if (!moved) {
      return;
    }
    messages.splice(targetIndex, 0, moved);
    void (async () => {
      const previousQueueState = applyOptimisticQueuedComposerState(activeThread.id, (state) => ({
        ...state,
        messages,
      }));
      const succeeded = await dispatchQueuedComposerCommand(
        activeThread.id,
        ({ commandId, threadId: targetThreadId }) => ({
          type: "thread.queue.reorder" as const,
          commandId,
          threadId: targetThreadId,
          messageIds: messages.map((m) => m.id),
        }),
      );
      if (!succeeded) {
        restoreOptimisticQueuedComposerState(previousQueueState);
      }
    })();
  };

  return {
    setPrompt,
    addComposerImagesToDraft,
    addComposerTerminalContextsToDraft,
    onSend,
    handleComposerSubmit,
    queueCurrentComposerMessage,
    handleQueueComposerMessage,
    onEditQueuedComposerMessage,
    onSteerQueuedComposerMessage,
    handleSubagentComposerSubmit,
    canSendQueuedComposerMessages,
    readCurrentComposerExecutionModeState,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    submitWorkspaceAgentNote,
    dismissPendingComposerComment,
    clearPendingComposerComments,
    pendingComposerComments,
    queuePreparedMessage,
    removeQueuedComposerMessage,
    clearQueuedComposerMessages,
    reorderQueuedComposerMessages,
    dispatchQueuedComposerMessage,
    ensureQueuedComposerThread,
    appendQueuedComposerMessage,
  };
}
