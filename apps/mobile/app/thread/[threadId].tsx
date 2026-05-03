import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Archive,
  ArrowUp,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Globe,
  Pencil,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react-native";
import type {
  ApprovalRequestId,
  ModelSelection,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderApprovalDecision,
  ProviderKind,
  QueuedComposerImageAttachment,
  QueuedComposerMessage,
  RuntimeMode,
  ServerProvider,
  ThreadHandoffMode,
  ThreadId,
  UserInputQuestion,
} from "@ace/contracts";
import { DEFAULT_MODEL_BY_PROVIDER, PROVIDER_DISPLAY_NAMES } from "@ace/contracts";
import { newCommandId, newMessageId, newThreadId } from "@ace/shared/ids";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
} from "@ace/shared/terminalContext";
import {
  buildCheckpointRestoreConfirmation,
  checkpointRestoreFailureMessage,
  usesTranscriptRebuildRestore,
} from "@ace/shared/checkpointRestore";
import { formatShortTimestamp } from "@ace/shared/timeFormat";
import { useTheme } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { Panel, ScreenBackdrop, SectionTitle, StatusBadge } from "../../src/design/primitives";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useHostStore } from "../../src/store/HostStore";
import { upsertThreadMessage } from "../../src/chat/threadMessages";
import {
  formatTimeAgo,
  resolveMobileThreadErrorDismissalKey,
  resolveMobileThreadStatus,
} from "../../src/orchestration/mobileData";
import {
  ImageAttachmentCapture,
  queuedComposerImageToMobileImageAttachment,
  toUploadChatAttachments,
  type MobileImageAttachment,
} from "../../src/components/ImageAttachmentCapture";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "../../src/thread/threadActivity";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanPreview,
  proposedPlanTitle,
} from "../../src/thread/proposedPlan";
import {
  applyMobileModelTraitPatch,
  hasVisibleMobileModelTraits,
  resolveMobileModelTraitState,
  type MobileModelTraitPatch,
} from "../../src/thread/modelTraits";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";
import { useMobileTerminalContextStore } from "../../src/store/MobileTerminalContextStore";

type ThreadPanel = "chat" | "diff" | "todo";

const PANEL_OPTIONS: ReadonlyArray<{ key: ThreadPanel; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "diff", label: "Diff" },
  { key: "todo", label: "Todo" },
];
const HANDOFF_MODES: ReadonlyArray<{
  value: ThreadHandoffMode;
  label: string;
  description: string;
}> = [
  { value: "compact", label: "Compact", description: "Summary" },
  { value: "transcript", label: "Full", description: "Transcript" },
];
const RUNTIME_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string }> = [
  { value: "full-access", label: "Full" },
  { value: "approval-required", label: "Review" },
];
const INTERACTION_MODE_OPTIONS: ReadonlyArray<{
  value: ProviderInteractionMode;
  label: string;
}> = [
  { value: "default", label: "Build" },
  { value: "plan", label: "Plan" },
];
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/giu;
const TRAILING_URL_PUNCTUATION_PATTERN = /[),.;:!?]+$/u;
const MOBILE_DIFF_PREVIEW_LIMIT = 40_000;
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

type UserInputDraftAnswers = Record<string, Record<string, unknown>>;

function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const normalized = match[0].replace(TRAILING_URL_PUNCTUATION_PATTERN, "");
    if (normalized.length > 0) {
      urls.add(normalized);
    }
  }
  return [...urls];
}

function formatUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function resolveHandoffModelSelection(
  provider: ProviderKind,
  availableProviders: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const providerConfig = availableProviders.find((entry) => entry.provider === provider);
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[provider];
  const model =
    providerConfig?.models.find((candidate) => candidate.slug === defaultModel)?.slug ??
    providerConfig?.models[0]?.slug ??
    defaultModel;

  return {
    provider,
    model,
  } as ModelSelection;
}

function resolveThreadErrorMessage(thread: OrchestrationThread | null): string | null {
  if (!thread) {
    return null;
  }
  if (thread.session?.status === "error") {
    return thread.session.lastError ?? "The provider session stopped with an error.";
  }
  if (thread.latestTurn?.state === "error") {
    return "The latest turn stopped with an error.";
  }
  return null;
}

export default function ThreadChatScreen() {
  const { threadId, hostId } = useLocalSearchParams<{
    threadId: string;
    hostId: string;
  }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const hosts = useHostStore((state) => state.hosts);
  const [connection, setConnection] = useState<ManagedConnection | null>(null);
  const [thread, setThread] = useState<OrchestrationThread | null>(null);
  const [messages, setMessages] = useState<readonly OrchestrationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [composerImages, setComposerImages] = useState<MobileImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [activePanel, setActivePanel] = useState<ThreadPanel>("chat");
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [userInputError, setUserInputError] = useState<string | null>(null);
  const [userInputDraftAnswers, setUserInputDraftAnswers] = useState<UserInputDraftAnswers>({});
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [handoffProvider, setHandoffProvider] = useState<ProviderKind | null>(null);
  const [handoffMode, setHandoffMode] = useState<ThreadHandoffMode>("compact");
  const [handoffInFlight, setHandoffInFlight] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [implementingPlanMode, setImplementingPlanMode] = useState<"current" | "new" | null>(null);
  const [planActionError, setPlanActionError] = useState<string | null>(null);
  const [modeUpdating, setModeUpdating] = useState<
    "runtime" | "interaction" | "model" | "traits" | null
  >(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const confirmThreadArchive = useMobilePreferencesStore((state) => state.confirmThreadArchive);
  const confirmThreadDelete = useMobilePreferencesStore((state) => state.confirmThreadDelete);
  const dismissedThreadErrorKeysById = useMobilePreferencesStore(
    (state) => state.dismissedThreadErrorKeysById,
  );
  const dismissThreadError = useMobilePreferencesStore((state) => state.dismissThreadError);
  const diffWordWrap = useMobilePreferencesStore((state) => state.diffWordWrap);
  const composerTerminalContexts = useMobileTerminalContextStore(
    (state) => state.contextsByThreadId[threadId] ?? [],
  );
  const clearComposerTerminalContexts = useMobileTerminalContextStore(
    (state) => state.clearThreadContexts,
  );
  const removeComposerTerminalContext = useMobileTerminalContextStore(
    (state) => state.removeThreadContext,
  );
  const setComposerTerminalContexts = useMobileTerminalContextStore(
    (state) => state.setThreadContexts,
  );
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const connected = connectionManager
      .getConnections()
      .find((candidate) => candidate.host.id === hostId);
    setConnection(connected ?? null);

    return connectionManager.onStatusChange((connections) => {
      setConnection(connections.find((candidate) => candidate.host.id === hostId) ?? null);
    });
  }, [hostId]);

  const activeHost = useMemo(
    () => hosts.find((host) => host.id === hostId) ?? connection?.host ?? null,
    [connection?.host, hostId, hosts],
  );
  const hostOffline =
    Boolean(activeHost) && (!connection || connection.status.kind !== "connected");
  const connectionError =
    connection?.status.kind === "disconnected" && connection.status.error
      ? connection.status.error
      : null;

  const loadThread = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !threadId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const nextThread = await connection.client.orchestration.getThread(threadId as never);
      setThread(nextThread);
      setMessages(nextThread.messages);
    } finally {
      setLoading(false);
    }
  }, [connection, threadId]);

  useEffect(() => {
    void loadThread();
  }, [loadThread]);

  const reconnectHost = useCallback(async () => {
    if (!activeHost || reconnecting) {
      return;
    }

    setReconnecting(true);
    setReconnectError(null);
    try {
      const client = await connectionManager.connect(activeHost, { forceReconnect: true });
      await client.server.getConfig();
      if (threadId) {
        const nextThread = await client.orchestration.getThread(threadId as ThreadId);
        setThread(nextThread);
        setMessages(nextThread.messages);
      }
    } catch (cause) {
      setReconnectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReconnecting(false);
    }
  }, [activeHost, reconnecting, threadId]);

  useEffect(() => {
    if (!connection || connection.status.kind !== "connected") {
      setProviders([]);
      setHandoffProvider(null);
      return;
    }

    let cancelled = false;
    connection.client.server
      .getConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }
        const readyProviders = config.providers.filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.status !== "disabled" &&
            provider.auth.status !== "unauthenticated",
        );
        setProviders(readyProviders);
      })
      .catch(() => {
        if (!cancelled) {
          setProviders([]);
          setHandoffProvider(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  useEffect(() => {
    if (!connection || connection.status.kind !== "connected" || !threadId) {
      return;
    }

    return connection.client.orchestration.onDomainEvent((event) => {
      if (event.aggregateId !== threadId) {
        return;
      }

      if (event.type === "thread.message-sent" && "message" in event.payload) {
        const nextMessage = event.payload.message as OrchestrationMessage;
        setMessages((currentMessages) => upsertThreadMessage(currentMessages, nextMessage));
      }

      void loadThread();
    });
  }, [connection, loadThread, threadId]);

  const isRunning = thread?.session?.status === "running" || thread?.session?.status === "starting";

  const handleSend = useCallback(async () => {
    if (
      (!input.trim() && composerImages.length === 0 && composerTerminalContexts.length === 0) ||
      !connection ||
      connection.status.kind !== "connected" ||
      !thread
    ) {
      return;
    }

    const text = input.trim();
    const basePrompt =
      text.length > 0 ? text : composerImages.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "";
    const terminalContexts = composerTerminalContexts.map((context) => ({ ...context }));
    const attachments = toUploadChatAttachments(composerImages);
    const queuedImages: QueuedComposerImageAttachment[] = composerImages.map((image) => ({
      type: "image",
      id: image.id as QueuedComposerImageAttachment["id"],
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.dataUrl,
    }));
    setInput("");
    setComposerImages([]);
    setSending(true);

    try {
      if (isRunning) {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.queue.append",
          commandId: newCommandId(),
          threadId: thread.id,
          message: {
            id: newMessageId(),
            prompt: basePrompt,
            images: queuedImages,
            terminalContexts,
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
          },
          position: "back",
        });
      } else {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: thread.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: appendTerminalContextsToPrompt(basePrompt, terminalContexts),
            attachments,
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString() as never,
        });
      }
      clearComposerTerminalContexts(thread.id);
      await loadThread();
    } finally {
      setSending(false);
    }
  }, [
    clearComposerTerminalContexts,
    composerImages,
    composerTerminalContexts,
    connection,
    input,
    isRunning,
    loadThread,
    thread,
  ]);

  const deleteQueuedMessage = useCallback(
    async (messageId: QueuedComposerMessage["id"]) => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      await connection.client.orchestration.dispatchCommand({
        type: "thread.queue.delete",
        commandId: newCommandId(),
        threadId: thread.id,
        messageId,
      });
      await loadThread();
    },
    [connection, loadThread, thread],
  );

  const editQueuedMessage = useCallback(
    async (messageId: QueuedComposerMessage["id"]) => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      const message = thread.queuedComposerMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        return;
      }

      await connection.client.orchestration.dispatchCommand({
        type: "thread.queue.delete",
        commandId: newCommandId(),
        threadId: thread.id,
        messageId,
      });
      setInput(message.prompt === IMAGE_ONLY_BOOTSTRAP_PROMPT ? "" : message.prompt);
      setComposerImages(message.images.map(queuedComposerImageToMobileImageAttachment));
      setComposerTerminalContexts(thread.id, message.terminalContexts);
      await loadThread();
    },
    [connection, loadThread, setComposerTerminalContexts, thread],
  );

  const reorderQueuedMessage = useCallback(
    async (messageId: QueuedComposerMessage["id"], direction: "up" | "down") => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      const currentIndex = thread.queuedComposerMessages.findIndex(
        (message) => message.id === messageId,
      );
      if (currentIndex < 0) {
        return;
      }

      const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex < 0 || nextIndex >= thread.queuedComposerMessages.length) {
        return;
      }

      const nextMessages = [...thread.queuedComposerMessages];
      const [message] = nextMessages.splice(currentIndex, 1);
      if (!message) {
        return;
      }
      nextMessages.splice(nextIndex, 0, message);

      await connection.client.orchestration.dispatchCommand({
        type: "thread.queue.reorder",
        commandId: newCommandId(),
        threadId: thread.id,
        messageIds: nextMessages.map((queuedMessage) => queuedMessage.id),
      });
      await loadThread();
    },
    [connection, loadThread, thread],
  );

  const clearQueuedMessages = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    await connection.client.orchestration.dispatchCommand({
      type: "thread.queue.clear",
      commandId: newCommandId(),
      threadId: thread.id,
    });
    await loadThread();
  }, [connection, loadThread, thread]);

  const steerQueuedMessage = useCallback(
    async (messageId: QueuedComposerMessage["id"]) => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      await connection.client.orchestration.dispatchCommand({
        type: "thread.queue.steer",
        commandId: newCommandId(),
        threadId: thread.id,
        messageId,
        baselineWorkLogEntryCount: thread.activities.length,
        interruptRequested: false,
      });
      await loadThread();
    },
    [connection, loadThread, thread],
  );

  const updateRuntimeMode = useCallback(
    async (runtimeMode: RuntimeMode) => {
      if (
        !connection ||
        connection.status.kind !== "connected" ||
        !thread ||
        thread.runtimeMode === runtimeMode ||
        modeUpdating
      ) {
        return;
      }

      setModeUpdating("runtime");
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: thread.id,
          runtimeMode,
          createdAt: new Date().toISOString(),
        });
        await loadThread();
      } finally {
        setModeUpdating(null);
      }
    },
    [connection, loadThread, modeUpdating, thread],
  );

  const updateInteractionMode = useCallback(
    async (interactionMode: ProviderInteractionMode) => {
      if (
        !connection ||
        connection.status.kind !== "connected" ||
        !thread ||
        thread.interactionMode === interactionMode ||
        modeUpdating
      ) {
        return;
      }

      setModeUpdating("interaction");
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: thread.id,
          interactionMode,
          createdAt: new Date().toISOString(),
        });
        await loadThread();
      } finally {
        setModeUpdating(null);
      }
    },
    [connection, loadThread, modeUpdating, thread],
  );

  const updateThreadModel = useCallback(
    async (model: string) => {
      if (
        !connection ||
        connection.status.kind !== "connected" ||
        !thread ||
        thread.modelSelection.model === model ||
        modeUpdating
      ) {
        return;
      }

      setModeUpdating("model");
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: thread.id,
          modelSelection: {
            ...thread.modelSelection,
            model,
          } as ModelSelection,
        });
        await loadThread();
      } finally {
        setModeUpdating(null);
      }
    },
    [connection, loadThread, modeUpdating, thread],
  );

  const updateThreadModelTraits = useCallback(
    async (patch: MobileModelTraitPatch) => {
      if (!connection || connection.status.kind !== "connected" || !thread || modeUpdating) {
        return;
      }

      setModeUpdating("traits");
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: thread.id,
          modelSelection: applyMobileModelTraitPatch(thread.modelSelection, patch),
        });
        await loadThread();
      } finally {
        setModeUpdating(null);
      }
    },
    [connection, loadThread, modeUpdating, thread],
  );

  const handleInterrupt = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    await connection.client.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: thread.id,
    } as never);
  }, [connection, thread]);

  const archiveThreadNow = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    await connection.client.orchestration.dispatchCommand({
      type: "thread.archive",
      commandId: newCommandId(),
      threadId: thread.id,
    });
    router.back();
  }, [connection, router, thread]);

  const archiveThread = useCallback(() => {
    if (!thread) {
      return;
    }
    if (!confirmThreadArchive) {
      void archiveThreadNow();
      return;
    }

    Alert.alert("Archive thread", `Archive ${thread.title}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Archive",
        onPress: () => void archiveThreadNow(),
      },
    ]);
  }, [archiveThreadNow, confirmThreadArchive, thread]);

  const deleteThreadNow = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || !thread) {
      return;
    }

    await connection.client.orchestration.dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId: thread.id,
    });
    router.back();
  }, [connection, router, thread]);

  const deleteThread = useCallback(() => {
    if (!thread) {
      return;
    }
    if (!confirmThreadDelete) {
      void deleteThreadNow().catch(() => undefined);
      return;
    }

    Alert.alert("Delete thread", `Delete ${thread.title}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteThreadNow().catch(() => undefined);
        },
      },
    ]);
  }, [confirmThreadDelete, deleteThreadNow, thread]);

  const openBrowserUrl = useCallback(
    (url: string) => {
      router.push({
        pathname: "/thread/browser",
        params: { url },
      });
    },
    [router],
  );

  const handleApprovalResponse = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      setRespondingApprovalId(requestId);
      setApprovalError(null);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: thread.id,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
        await loadThread();
      } catch (cause) {
        setApprovalError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRespondingApprovalId(null);
      }
    },
    [connection, loadThread, thread],
  );

  const updateUserInputAnswer = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, value: unknown) => {
      setUserInputDraftAnswers((current) => ({
        ...current,
        [requestId]: {
          ...current[requestId],
          [question.id]: value,
        },
      }));
    },
    [],
  );

  const toggleUserInputOption = useCallback(
    (requestId: ApprovalRequestId, question: UserInputQuestion, optionLabel: string) => {
      setUserInputDraftAnswers((current) => {
        const existingAnswers = current[requestId] ?? {};
        const currentValue = existingAnswers[question.id];
        const nextValue = question.multiSelect
          ? Array.isArray(currentValue)
            ? currentValue.includes(optionLabel)
              ? currentValue.filter((value): value is string => value !== optionLabel)
              : [...currentValue, optionLabel]
            : [optionLabel]
          : optionLabel;

        return {
          ...current,
          [requestId]: {
            ...existingAnswers,
            [question.id]: nextValue,
          },
        };
      });
    },
    [],
  );

  const handleUserInputResponse = useCallback(
    async (requestId: ApprovalRequestId) => {
      if (!connection || connection.status.kind !== "connected" || !thread) {
        return;
      }

      setRespondingUserInputId(requestId);
      setUserInputError(null);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: thread.id,
          requestId,
          answers: userInputDraftAnswers[requestId] ?? {},
          createdAt: new Date().toISOString(),
        });
        setUserInputDraftAnswers((current) => {
          const { [requestId]: _removed, ...rest } = current;
          return rest;
        });
        await loadThread();
      } catch (cause) {
        setUserInputError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRespondingUserInputId(null);
      }
    },
    [connection, loadThread, thread, userInputDraftAnswers],
  );

  const threadErrorMessage = useMemo(() => resolveThreadErrorMessage(thread), [thread]);
  const threadErrorDismissalKey = useMemo(
    () => (thread ? resolveMobileThreadErrorDismissalKey(thread) : null),
    [thread],
  );
  const threadErrorDismissed =
    Boolean(thread?.id && threadErrorDismissalKey) &&
    dismissedThreadErrorKeysById[thread?.id ?? ""] === threadErrorDismissalKey;
  const visibleThreadError = threadErrorDismissed ? null : threadErrorMessage;
  const status = useMemo(
    () => (thread ? resolveMobileThreadStatus(thread, dismissedThreadErrorKeysById) : null),
    [dismissedThreadErrorKeysById, thread],
  );
  const diffCheckpoints = thread?.checkpoints ?? [];
  const todoActivities = useMemo(
    () => (thread?.activities ?? []).filter((activity) => activity.tone !== "info"),
    [thread?.activities],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(thread?.activities ?? []),
    [thread?.activities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(thread?.activities ?? []),
    [thread?.activities],
  );
  const activeProposedPlan = useMemo<OrchestrationProposedPlan | null>(() => {
    if (!thread) {
      return null;
    }

    const summary = thread.latestProposedPlanSummary;
    const bySummary = summary
      ? (thread.proposedPlans.find((plan) => plan.id === summary.id) ?? null)
      : null;
    if (bySummary?.implementedAt === null) {
      return bySummary;
    }
    return thread.proposedPlans.findLast((plan) => plan.implementedAt === null) ?? null;
  }, [thread]);
  const handoffProviders = useMemo(() => {
    if (!thread) {
      return [];
    }
    return providers.filter((provider) => provider.provider !== thread.modelSelection.provider);
  }, [providers, thread]);
  const currentProviderModels = useMemo(() => {
    if (!thread) {
      return [];
    }

    const providerConfig = providers.find(
      (provider) => provider.provider === thread.modelSelection.provider,
    );
    const models = providerConfig?.models ?? [];
    if (models.some((model) => model.slug === thread.modelSelection.model)) {
      return models;
    }

    return [
      {
        slug: thread.modelSelection.model,
        name: thread.modelSelection.model,
        isCustom: true,
        capabilities: null,
      },
      ...models,
    ];
  }, [providers, thread]);
  const modelTraitState = useMemo(() => {
    if (!thread) {
      return null;
    }
    return resolveMobileModelTraitState(thread.modelSelection, currentProviderModels);
  }, [currentProviderModels, thread]);
  const toolActivities = useMemo(
    () => (thread?.activities ?? []).filter((activity) => activity.tone === "tool").slice(-3),
    [thread?.activities],
  );
  const canSend =
    Boolean(thread) &&
    Boolean(connection) &&
    connection?.status.kind === "connected" &&
    !sending &&
    (input.trim().length > 0 || composerImages.length > 0 || composerTerminalContexts.length > 0);

  useEffect(() => {
    if (
      handoffProvider &&
      handoffProviders.some((provider) => provider.provider === handoffProvider)
    ) {
      return;
    }
    setHandoffProvider(handoffProviders[0]?.provider ?? null);
  }, [handoffProvider, handoffProviders]);

  const handleHandoff = useCallback(async () => {
    if (
      !connection ||
      connection.status.kind !== "connected" ||
      !thread ||
      !handoffProvider ||
      handoffInFlight
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const destinationThreadId = newThreadId();
    const providerLabel = PROVIDER_DISPLAY_NAMES[handoffProvider] ?? handoffProvider;
    const modelSelection = resolveHandoffModelSelection(handoffProvider, providers);

    setHandoffInFlight(true);
    setHandoffError(null);
    try {
      await connection.client.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: destinationThreadId,
        projectId: thread.projectId,
        title: `${thread.title} to ${providerLabel}`,
        modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        handoff: {
          sourceThreadId: thread.id,
          fromProvider: thread.modelSelection.provider,
          toProvider: handoffProvider,
          mode: handoffMode,
          createdAt,
        },
        createdAt,
      });
      router.push({
        pathname: "/thread/[threadId]",
        params: { threadId: destinationThreadId, hostId },
      });
    } catch (cause) {
      setHandoffError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHandoffInFlight(false);
    }
  }, [
    connection,
    handoffInFlight,
    handoffMode,
    handoffProvider,
    hostId,
    providers,
    router,
    thread,
  ]);

  const implementPlanInCurrentThread = useCallback(async () => {
    if (
      !connection ||
      connection.status.kind !== "connected" ||
      !thread ||
      !activeProposedPlan ||
      implementingPlanMode ||
      isRunning
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    setImplementingPlanMode("current");
    setPlanActionError(null);
    try {
      await connection.client.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: thread.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildPlanImplementationPrompt(activeProposedPlan.planMarkdown),
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        titleSeed: thread.title,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        sourceProposedPlan: {
          threadId: thread.id,
          planId: activeProposedPlan.id,
        },
        createdAt,
      });
      await loadThread();
    } catch (cause) {
      setPlanActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImplementingPlanMode(null);
    }
  }, [activeProposedPlan, connection, implementingPlanMode, isRunning, loadThread, thread]);

  const implementPlanInNewThread = useCallback(async () => {
    if (
      !connection ||
      connection.status.kind !== "connected" ||
      !thread ||
      !activeProposedPlan ||
      implementingPlanMode
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const destinationThreadId = newThreadId();
    const title = buildPlanImplementationThreadTitle(activeProposedPlan.planMarkdown);

    setImplementingPlanMode("new");
    setPlanActionError(null);
    try {
      await connection.client.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: destinationThreadId,
        projectId: thread.projectId,
        title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        createdAt,
      });
      await connection.client.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: destinationThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildPlanImplementationPrompt(activeProposedPlan.planMarkdown),
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        titleSeed: title,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        sourceProposedPlan: {
          threadId: thread.id,
          planId: activeProposedPlan.id,
        },
        createdAt,
      });
      router.push({
        pathname: "/thread/[threadId]",
        params: { threadId: destinationThreadId, hostId },
      });
    } catch (cause) {
      await connection.client.orchestration
        .dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: destinationThreadId,
        })
        .catch(() => undefined);
      setPlanActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImplementingPlanMode(null);
    }
  }, [activeProposedPlan, connection, hostId, implementingPlanMode, router, thread]);

  if (loading && !thread) {
    return (
      <View style={[styles.loadingRoot, { backgroundColor: colors.background }]}>
        <ScreenBackdrop />
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <Stack.Screen options={{ headerShown: false }} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 18 : 0}
      >
        <View
          style={[
            styles.header,
            {
              paddingTop: insets.top + 10,
              backgroundColor: colors.background,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Pressable
              onPress={() => router.back()}
              style={[
                styles.headerButton,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.elevatedBorder,
                  shadowColor: colors.shadow,
                },
              ]}
            >
              <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.2} />
            </Pressable>

            <View style={styles.headerCopy}>
              <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>
                {thread ? formatTimeAgo(thread.updatedAt) : ""}
              </Text>
              <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
                {thread?.title ?? "Thread"}
              </Text>
              <Text
                style={[styles.headerSubtitle, { color: colors.secondaryLabel }]}
                numberOfLines={1}
              >
                {connection?.host.name ?? "Unknown host"}
              </Text>
            </View>

            {isRunning ? (
              <Pressable
                onPress={() => void handleInterrupt()}
                style={[
                  styles.stopButton,
                  {
                    backgroundColor: withAlpha(colors.red, 0.14),
                    borderColor: withAlpha(colors.red, 0.2),
                  },
                ]}
              >
                <Square size={12} color={colors.red} fill={colors.red} />
                <Text style={[styles.stopLabel, { color: colors.red }]}>Stop</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/thread/terminal",
                    params: {
                      threadId,
                      hostId,
                      cwd: thread?.worktreePath ?? undefined,
                    },
                  })
                }
                style={[
                  styles.headerButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.elevatedBorder,
                    shadowColor: colors.shadow,
                  },
                ]}
              >
                <Terminal size={18} color={colors.foreground} strokeWidth={2.2} />
              </Pressable>
            )}
          </View>

          <Panel style={styles.summaryPanel}>
            <View style={styles.summaryTop}>
              {status ? <StatusBadge label={status.label} tone={status.tone} /> : null}
              <Text style={[styles.summaryMeta, { color: colors.tertiaryLabel }]}>
                {messages.length} messages
              </Text>
            </View>
            {visibleThreadError && thread && threadErrorDismissalKey ? (
              <View
                style={[
                  styles.threadErrorBanner,
                  {
                    backgroundColor: withAlpha(colors.red, 0.1),
                    borderColor: withAlpha(colors.red, 0.22),
                  },
                ]}
              >
                <Text style={[styles.threadErrorText, { color: colors.red }]} numberOfLines={3}>
                  {visibleThreadError}
                </Text>
                <Pressable
                  onPress={() => dismissThreadError(thread.id, threadErrorDismissalKey)}
                  style={[
                    styles.threadErrorDismissButton,
                    {
                      backgroundColor: colors.surface,
                      borderColor: withAlpha(colors.red, 0.24),
                    },
                  ]}
                >
                  <Text style={[styles.threadErrorDismissLabel, { color: colors.red }]}>
                    Dismiss
                  </Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.panelTabs}>
              {PANEL_OPTIONS.map((panel) => {
                const active = panel.key === activePanel;
                return (
                  <Pressable
                    key={panel.key}
                    onPress={() => setActivePanel(panel.key)}
                    style={[
                      styles.panelTab,
                      {
                        backgroundColor: active ? colors.surfaceSecondary : "transparent",
                        borderColor: active ? colors.elevatedBorder : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.panelTabLabel,
                        { color: active ? colors.foreground : colors.secondaryLabel },
                      ]}
                    >
                      {panel.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {thread ? (
              <View style={styles.threadModeGrid}>
                <View style={styles.threadModeGroup}>
                  <Text style={[styles.threadModeLabel, { color: colors.tertiaryLabel }]}>
                    Access
                  </Text>
                  <View style={styles.threadModeRow}>
                    {RUNTIME_MODE_OPTIONS.map((option) => {
                      const active = option.value === thread.runtimeMode;
                      return (
                        <Pressable
                          key={option.value}
                          disabled={modeUpdating !== null || hostOffline}
                          onPress={() => void updateRuntimeMode(option.value)}
                          style={[
                            styles.threadModeChip,
                            {
                              backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                              borderColor: active ? colors.primary : colors.elevatedBorder,
                            },
                            (modeUpdating !== null || hostOffline) && styles.disabledButton,
                          ]}
                        >
                          <Text
                            style={[
                              styles.threadModeChipLabel,
                              { color: active ? colors.primaryForeground : colors.foreground },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                <View style={styles.threadModeGroup}>
                  <Text style={[styles.threadModeLabel, { color: colors.tertiaryLabel }]}>
                    Mode
                  </Text>
                  <View style={styles.threadModeRow}>
                    {INTERACTION_MODE_OPTIONS.map((option) => {
                      const active = option.value === thread.interactionMode;
                      return (
                        <Pressable
                          key={option.value}
                          disabled={modeUpdating !== null || hostOffline}
                          onPress={() => void updateInteractionMode(option.value)}
                          style={[
                            styles.threadModeChip,
                            {
                              backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                              borderColor: active ? colors.primary : colors.elevatedBorder,
                            },
                            (modeUpdating !== null || hostOffline) && styles.disabledButton,
                          ]}
                        >
                          <Text
                            style={[
                              styles.threadModeChipLabel,
                              { color: active ? colors.primaryForeground : colors.foreground },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
            ) : null}
            {thread && currentProviderModels.length > 0 ? (
              <View style={styles.threadModelGroup}>
                <Text style={[styles.threadModeLabel, { color: colors.tertiaryLabel }]}>Model</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.threadModelStrip}
                >
                  {currentProviderModels.map((model) => {
                    const active = model.slug === thread.modelSelection.model;
                    return (
                      <Pressable
                        key={model.slug}
                        disabled={modeUpdating !== null || hostOffline}
                        onPress={() => void updateThreadModel(model.slug)}
                        style={[
                          styles.threadModelChip,
                          {
                            backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                            borderColor: active ? colors.primary : colors.elevatedBorder,
                          },
                          (modeUpdating !== null || hostOffline) && styles.disabledButton,
                        ]}
                      >
                        <Text
                          style={[
                            styles.threadModelChipLabel,
                            { color: active ? colors.primaryForeground : colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {model.name || model.slug}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}
            {thread && modelTraitState && hasVisibleMobileModelTraits(modelTraitState) ? (
              <View style={styles.threadModelGroup}>
                <Text style={[styles.threadModeLabel, { color: colors.tertiaryLabel }]}>
                  Traits
                </Text>
                {modelTraitState.capabilities.reasoningEffortLevels.length > 0 ? (
                  <View style={styles.threadTraitBlock}>
                    <Text style={[styles.threadTraitLabel, { color: colors.secondaryLabel }]}>
                      Effort
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.threadModelStrip}
                    >
                      {modelTraitState.capabilities.reasoningEffortLevels.map((option) => {
                        const active = option.value === modelTraitState.effort;
                        return (
                          <Pressable
                            key={option.value}
                            disabled={modeUpdating !== null || hostOffline}
                            onPress={() =>
                              void updateThreadModelTraits({
                                kind: "effort",
                                value: option.value,
                              })
                            }
                            style={[
                              styles.threadTraitChip,
                              {
                                backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                                borderColor: active ? colors.primary : colors.elevatedBorder,
                              },
                              (modeUpdating !== null || hostOffline) && styles.disabledButton,
                            ]}
                          >
                            <Text
                              style={[
                                styles.threadTraitChipLabel,
                                { color: active ? colors.primaryForeground : colors.foreground },
                              ]}
                            >
                              {option.label}
                              {option.value === modelTraitState.defaultEffort ? " *" : ""}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
                {modelTraitState.thinking !== null ? (
                  <View style={styles.threadTraitBlock}>
                    <Text style={[styles.threadTraitLabel, { color: colors.secondaryLabel }]}>
                      Thinking
                    </Text>
                    <View style={styles.threadModeRow}>
                      {[
                        { value: true, label: "On" },
                        { value: false, label: "Off" },
                      ].map((option) => {
                        const active = option.value === modelTraitState.thinking;
                        return (
                          <Pressable
                            key={String(option.value)}
                            disabled={modeUpdating !== null || hostOffline}
                            onPress={() =>
                              void updateThreadModelTraits({
                                kind: "thinking",
                                value: option.value,
                              })
                            }
                            style={[
                              styles.threadTraitChip,
                              {
                                backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                                borderColor: active ? colors.primary : colors.elevatedBorder,
                              },
                              (modeUpdating !== null || hostOffline) && styles.disabledButton,
                            ]}
                          >
                            <Text
                              style={[
                                styles.threadTraitChipLabel,
                                { color: active ? colors.primaryForeground : colors.foreground },
                              ]}
                            >
                              {option.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                {modelTraitState.fastMode !== null ? (
                  <View style={styles.threadTraitBlock}>
                    <Text style={[styles.threadTraitLabel, { color: colors.secondaryLabel }]}>
                      Fast mode
                    </Text>
                    <View style={styles.threadModeRow}>
                      {[
                        { value: false, label: "Off" },
                        { value: true, label: "On" },
                      ].map((option) => {
                        const active = option.value === modelTraitState.fastMode;
                        return (
                          <Pressable
                            key={String(option.value)}
                            disabled={modeUpdating !== null || hostOffline}
                            onPress={() =>
                              void updateThreadModelTraits({
                                kind: "fastMode",
                                value: option.value,
                              })
                            }
                            style={[
                              styles.threadTraitChip,
                              {
                                backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                                borderColor: active ? colors.primary : colors.elevatedBorder,
                              },
                              (modeUpdating !== null || hostOffline) && styles.disabledButton,
                            ]}
                          >
                            <Text
                              style={[
                                styles.threadTraitChipLabel,
                                { color: active ? colors.primaryForeground : colors.foreground },
                              ]}
                            >
                              {option.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                {modelTraitState.capabilities.contextWindowOptions.length > 1 ? (
                  <View style={styles.threadTraitBlock}>
                    <Text style={[styles.threadTraitLabel, { color: colors.secondaryLabel }]}>
                      {modelTraitState.contextLabel}
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.threadModelStrip}
                    >
                      {modelTraitState.capabilities.contextWindowOptions.map((option) => {
                        const active = option.value === modelTraitState.contextWindow;
                        return (
                          <Pressable
                            key={option.value}
                            disabled={modeUpdating !== null || hostOffline}
                            onPress={() =>
                              void updateThreadModelTraits({
                                kind: "contextWindow",
                                value: option.value,
                              })
                            }
                            style={[
                              styles.threadTraitChip,
                              {
                                backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                                borderColor: active ? colors.primary : colors.elevatedBorder,
                              },
                              (modeUpdating !== null || hostOffline) && styles.disabledButton,
                            ]}
                          >
                            <Text
                              style={[
                                styles.threadTraitChipLabel,
                                { color: active ? colors.primaryForeground : colors.foreground },
                              ]}
                            >
                              {option.label}
                              {option.value === modelTraitState.defaultContextWindow ? " *" : ""}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </View>
                ) : null}
              </View>
            ) : null}
          </Panel>
        </View>

        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: insets.bottom + 20,
            },
          ]}
          onContentSizeChange={() => {
            if (activePanel === "chat") {
              scrollRef.current?.scrollToEnd({ animated: true });
            }
          }}
        >
          {activePanel === "chat" ? (
            <ChatPanel
              messages={messages}
              toolActivities={toolActivities}
              thread={thread}
              onOpenBrowserUrl={openBrowserUrl}
              onEditQueuedMessage={editQueuedMessage}
              onDeleteQueuedMessage={deleteQueuedMessage}
              onReorderQueuedMessage={reorderQueuedMessage}
              onClearQueuedMessages={clearQueuedMessages}
              onSteerQueuedMessage={steerQueuedMessage}
            />
          ) : null}

          {activePanel === "diff" ? (
            <DiffPanel
              checkpoints={diffCheckpoints}
              connection={connection}
              diffWordWrap={diffWordWrap}
              isRunning={isRunning}
              onReverted={loadThread}
              provider={thread?.modelSelection.provider ?? null}
              threadId={threadId}
            />
          ) : null}

          {activePanel === "todo" ? (
            <TodoPanel
              activities={todoActivities}
              proposedPlan={activeProposedPlan}
              canImplementPlan={!hostOffline && !isRunning}
              implementingPlanMode={implementingPlanMode}
              planActionError={planActionError}
              pendingApprovals={pendingApprovals}
              respondingApprovalId={respondingApprovalId}
              approvalError={approvalError}
              pendingUserInputs={pendingUserInputs}
              respondingUserInputId={respondingUserInputId}
              userInputDraftAnswers={userInputDraftAnswers}
              userInputError={userInputError}
              handoffProviders={handoffProviders}
              handoffProvider={handoffProvider}
              handoffMode={handoffMode}
              handoffInFlight={handoffInFlight}
              handoffError={handoffError}
              onApprovalResponse={handleApprovalResponse}
              onUserInputAnswerChange={updateUserInputAnswer}
              onUserInputOptionToggle={toggleUserInputOption}
              onUserInputResponse={handleUserInputResponse}
              onImplementPlanInCurrentThread={implementPlanInCurrentThread}
              onImplementPlanInNewThread={implementPlanInNewThread}
              onHandoffProviderChange={setHandoffProvider}
              onHandoffModeChange={setHandoffMode}
              onHandoff={handleHandoff}
              onArchiveThread={archiveThread}
              onDeleteThread={deleteThread}
            />
          ) : null}
        </ScrollView>

        <View
          style={[
            styles.composer,
            {
              backgroundColor: colors.background,
              borderTopColor: colors.separator,
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          {hostOffline ? (
            <View
              style={[
                styles.connectionRecoveryBanner,
                {
                  backgroundColor: withAlpha(colors.orange, 0.12),
                  borderColor: withAlpha(colors.orange, 0.22),
                },
              ]}
            >
              <View style={styles.connectionRecoveryCopy}>
                <Text style={[styles.connectionRecoveryTitle, { color: colors.foreground }]}>
                  Host disconnected
                </Text>
                <Text
                  style={[styles.connectionRecoveryBody, { color: colors.secondaryLabel }]}
                  numberOfLines={2}
                >
                  {connectionError ??
                    reconnectError ??
                    `Reconnect ${activeHost?.name ?? "this host"} to continue.`}
                </Text>
              </View>
              <Pressable
                disabled={reconnecting}
                onPress={() => void reconnectHost()}
                style={[
                  styles.connectionReconnectButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.elevatedBorder,
                  },
                  reconnecting && styles.disabledButton,
                ]}
              >
                {reconnecting ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <RefreshCw size={16} color={colors.primary} strokeWidth={2.3} />
                )}
                <Text style={[styles.connectionReconnectLabel, { color: colors.primary }]}>
                  Reconnect
                </Text>
              </Pressable>
            </View>
          ) : null}
          <ImageAttachmentCapture
            images={composerImages}
            onImagesChange={setComposerImages}
            disabled={sending || hostOffline}
            compact
          />
          {composerTerminalContexts.length > 0 ? (
            <View style={styles.terminalContextStrip}>
              {composerTerminalContexts.map((context) => (
                <View
                  key={context.id}
                  style={[
                    styles.terminalContextChip,
                    {
                      backgroundColor: withAlpha(colors.green, 0.12),
                      borderColor: withAlpha(colors.green, 0.22),
                    },
                  ]}
                >
                  <Terminal size={13} color={colors.green} strokeWidth={2.2} />
                  <Text
                    style={[styles.terminalContextLabel, { color: colors.foreground }]}
                    numberOfLines={1}
                  >
                    {formatTerminalContextLabel(context)}
                  </Text>
                  <Pressable
                    onPress={() => removeComposerTerminalContext(threadId, context.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${formatTerminalContextLabel(context)}`}
                    style={styles.terminalContextRemove}
                  >
                    <X size={13} color={colors.secondaryLabel} strokeWidth={2.3} />
                  </Pressable>
                </View>
              ))}
              <Pressable
                onPress={() => clearComposerTerminalContexts(threadId)}
                accessibilityRole="button"
                accessibilityLabel="Clear terminal context"
                style={[
                  styles.terminalContextClear,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <Text style={[styles.terminalContextClearLabel, { color: colors.secondaryLabel }]}>
                  Clear
                </Text>
              </Pressable>
            </View>
          ) : null}
          <View
            style={[
              styles.composerField,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Send a follow-up or instruction"
              placeholderTextColor={colors.muted}
              style={[styles.textInput, { color: colors.foreground }]}
              multiline
              editable={!sending && !hostOffline}
            />
            <Pressable
              onPress={() => void handleSend()}
              disabled={!canSend}
              style={[
                styles.sendButton,
                {
                  backgroundColor: canSend ? colors.primary : colors.surfaceSecondary,
                },
              ]}
            >
              <ArrowUp
                size={16}
                color={canSend ? colors.primaryForeground : colors.muted}
                strokeWidth={2.5}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function ChatPanel({
  messages,
  toolActivities,
  thread,
  onOpenBrowserUrl,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onReorderQueuedMessage,
  onClearQueuedMessages,
  onSteerQueuedMessage,
}: {
  messages: readonly OrchestrationMessage[];
  toolActivities: ReadonlyArray<OrchestrationThreadActivity>;
  thread: OrchestrationThread | null;
  onOpenBrowserUrl: (url: string) => void;
  onEditQueuedMessage: (messageId: QueuedComposerMessage["id"]) => void;
  onDeleteQueuedMessage: (messageId: QueuedComposerMessage["id"]) => void;
  onReorderQueuedMessage: (
    messageId: QueuedComposerMessage["id"],
    direction: "up" | "down",
  ) => void;
  onClearQueuedMessages: () => void;
  onSteerQueuedMessage: (messageId: QueuedComposerMessage["id"]) => void;
}) {
  const { colors } = useTheme();
  const timestampFormat = useMobilePreferencesStore((state) => state.timestampFormat);
  const queuedMessages = thread?.queuedComposerMessages ?? [];

  return (
    <View style={styles.chatPanel}>
      {messages.map((message) => {
        const isUser = message.role === "user";
        const urls = extractHttpUrls(message.text);

        return (
          <View
            key={message.id}
            style={[
              styles.messageCard,
              isUser
                ? [
                    styles.userMessage,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]
                : [
                    styles.assistantMessage,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                  ],
            ]}
          >
            <Text style={[styles.messageRole, { color: colors.tertiaryLabel }]}>
              {isUser ? "You" : "Agent"} ·{" "}
              {formatShortTimestamp(message.createdAt, timestampFormat)}
            </Text>
            <Text style={[styles.messageText, { color: colors.foreground }]}>
              {message.text}
              {message.streaming ? " ▍" : ""}
            </Text>
            {urls.length > 0 ? (
              <View style={styles.messageLinks}>
                {urls.slice(0, 4).map((url) => (
                  <Pressable
                    key={url}
                    onPress={() => onOpenBrowserUrl(url)}
                    style={[
                      styles.messageLink,
                      {
                        backgroundColor: withAlpha(colors.primary, 0.1),
                        borderColor: withAlpha(colors.primary, 0.22),
                      },
                    ]}
                  >
                    <Globe size={13} color={colors.primary} strokeWidth={2.2} />
                    <Text
                      style={[styles.messageLinkLabel, { color: colors.primary }]}
                      numberOfLines={1}
                    >
                      {formatUrlLabel(url)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}

      {queuedMessages.length > 0 ? (
        <Panel>
          <View style={styles.queueHeader}>
            <View>
              <SectionTitle>Queued</SectionTitle>
              <Text style={[styles.queueMeta, { color: colors.secondaryLabel }]}>
                {queuedMessages.length} waiting for the active turn
              </Text>
            </View>
            <Pressable
              onPress={onClearQueuedMessages}
              style={[
                styles.queueClearButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            >
              <Text style={[styles.queueClearLabel, { color: colors.foreground }]}>Clear</Text>
            </Pressable>
          </View>
          <View style={styles.queueList}>
            {queuedMessages.map((message, index) => {
              const isSteering = thread?.queuedSteerRequest?.messageId === message.id;
              const canMoveUp = index > 0;
              const canMoveDown = index < queuedMessages.length - 1;
              return (
                <View
                  key={message.id}
                  style={[
                    styles.queueRow,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <View style={styles.queueCopy}>
                    <Text style={[styles.queueTitle, { color: colors.tertiaryLabel }]}>
                      #{index + 1} · {message.images.length} images
                    </Text>
                    <Text
                      style={[styles.queuePrompt, { color: colors.foreground }]}
                      numberOfLines={3}
                    >
                      {message.prompt}
                    </Text>
                  </View>
                  <View style={styles.queueActions}>
                    <Pressable
                      onPress={() => onSteerQueuedMessage(message.id)}
                      style={[
                        styles.queueSteerButton,
                        {
                          backgroundColor: isSteering
                            ? withAlpha(colors.primary, 0.14)
                            : colors.surface,
                          borderColor: isSteering
                            ? withAlpha(colors.primary, 0.3)
                            : colors.elevatedBorder,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.queueSteerLabel,
                          { color: isSteering ? colors.primary : colors.foreground },
                        ]}
                      >
                        {isSteering ? "Steering" : "Steer"}
                      </Text>
                    </Pressable>
                    <View style={styles.queueIconActions}>
                      <Pressable
                        onPress={() => onReorderQueuedMessage(message.id, "up")}
                        disabled={!canMoveUp}
                        style={[
                          styles.queueIconButton,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.elevatedBorder,
                          },
                          !canMoveUp && styles.disabledButton,
                        ]}
                      >
                        <ChevronUp
                          size={15}
                          color={canMoveUp ? colors.foreground : colors.muted}
                          strokeWidth={2.2}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => onReorderQueuedMessage(message.id, "down")}
                        disabled={!canMoveDown}
                        style={[
                          styles.queueIconButton,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.elevatedBorder,
                          },
                          !canMoveDown && styles.disabledButton,
                        ]}
                      >
                        <ChevronDown
                          size={15}
                          color={canMoveDown ? colors.foreground : colors.muted}
                          strokeWidth={2.2}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => onEditQueuedMessage(message.id)}
                        style={[
                          styles.queueIconButton,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.elevatedBorder,
                          },
                        ]}
                      >
                        <Pencil size={15} color={colors.foreground} strokeWidth={2.2} />
                      </Pressable>
                      <Pressable
                        onPress={() => onDeleteQueuedMessage(message.id)}
                        style={[
                          styles.queueIconButton,
                          {
                            backgroundColor: withAlpha(colors.red, 0.1),
                            borderColor: withAlpha(colors.red, 0.2),
                          },
                        ]}
                      >
                        <Trash2 size={15} color={colors.red} strokeWidth={2.2} />
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        </Panel>
      ) : null}

      {toolActivities.length > 0 ? (
        <Panel>
          <SectionTitle>Recent tool activity</SectionTitle>
          <View style={styles.toolList}>
            {toolActivities.map((activity) => (
              <View
                key={activity.id}
                style={[
                  styles.toolRow,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <Text style={[styles.toolSummary, { color: colors.foreground }]} numberOfLines={2}>
                  {activity.summary}
                </Text>
              </View>
            ))}
          </View>
        </Panel>
      ) : null}

      {messages.length === 0 && !thread ? (
        <Text style={[styles.placeholderText, { color: colors.muted }]}>No thread loaded.</Text>
      ) : null}
    </View>
  );
}

function DiffPanel({
  checkpoints,
  connection,
  diffWordWrap,
  isRunning,
  onReverted,
  provider,
  threadId,
}: {
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  connection: ManagedConnection | null;
  diffWordWrap: boolean;
  isRunning: boolean;
  onReverted: () => Promise<void>;
  provider: ProviderKind | null;
  threadId: string;
}) {
  const { colors } = useTheme();
  const readyCheckpoints = useMemo(
    () =>
      checkpoints
        .filter((checkpoint) => checkpoint.status === "ready")
        .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount),
    [checkpoints],
  );
  const latestReadyCheckpoint = readyCheckpoints.at(-1) ?? null;
  const [selectedTurnCount, setSelectedTurnCount] = useState<number | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [loadingPatch, setLoadingPatch] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [revertingCheckpoint, setRevertingCheckpoint] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const checkpoint =
    readyCheckpoints.find((candidate) => candidate.checkpointTurnCount === selectedTurnCount) ??
    latestReadyCheckpoint;

  useEffect(() => {
    setSelectedTurnCount((current) => {
      if (
        current !== null &&
        readyCheckpoints.some((item) => item.checkpointTurnCount === current)
      ) {
        return current;
      }
      return latestReadyCheckpoint?.checkpointTurnCount ?? null;
    });
  }, [latestReadyCheckpoint?.checkpointTurnCount, readyCheckpoints]);

  useEffect(() => {
    setPatch(null);
    setPatchError(null);
    setRevertError(null);
  }, [checkpoint?.checkpointTurnCount, threadId]);

  const loadPatch = useCallback(async () => {
    if (!checkpoint) {
      return;
    }
    if (!connection || connection.status.kind !== "connected") {
      setPatchError("Connect this host before loading the diff patch.");
      return;
    }

    setLoadingPatch(true);
    setPatchError(null);
    try {
      const result = await connection.client.orchestration.getFullThreadDiff({
        threadId: threadId as ThreadId,
        toTurnCount: checkpoint.checkpointTurnCount,
      });
      setPatch(result.diff);
    } catch (cause) {
      setPatchError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingPatch(false);
    }
  }, [checkpoint, connection, threadId]);

  const requestRevert = useCallback(() => {
    if (!checkpoint) {
      return;
    }
    if (!connection || connection.status.kind !== "connected") {
      setRevertError("Connect this host before restoring a checkpoint.");
      return;
    }
    if (isRunning) {
      setRevertError("Stop the current turn before restoring a checkpoint.");
      return;
    }

    Alert.alert(
      usesTranscriptRebuildRestore(provider) ? "Restore checkpoint" : "Revert checkpoint",
      buildCheckpointRestoreConfirmation(provider, checkpoint.checkpointTurnCount),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: usesTranscriptRebuildRestore(provider) ? "Restore" : "Revert",
          style: "destructive",
          onPress: () => {
            setRevertingCheckpoint(true);
            setRevertError(null);
            connection.client.orchestration
              .dispatchCommand({
                type: "thread.checkpoint.revert",
                commandId: newCommandId(),
                threadId: threadId as ThreadId,
                turnCount: checkpoint.checkpointTurnCount,
                createdAt: new Date().toISOString(),
              })
              .then(onReverted)
              .catch((cause: unknown) => {
                setRevertError(
                  cause instanceof Error
                    ? cause.message
                    : checkpointRestoreFailureMessage(provider),
                );
              })
              .finally(() => {
                setRevertingCheckpoint(false);
              });
          },
        },
      ],
    );
  }, [checkpoint, connection, isRunning, onReverted, provider, threadId]);

  if (!checkpoint) {
    return (
      <Panel>
        <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>No diff yet</Text>
        <Text style={[styles.placeholderText, { color: colors.secondaryLabel }]}>
          Diff-ready turns will show changed files here once a checkpoint is available.
        </Text>
      </Panel>
    );
  }

  return (
    <Panel>
      <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>Checkpoint diff</Text>
      <Text style={[styles.placeholderMeta, { color: colors.secondaryLabel }]}>
        {checkpoint.files.length} files · {formatTimeAgo(checkpoint.completedAt)}
      </Text>
      {readyCheckpoints.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.checkpointStrip}
        >
          {readyCheckpoints.map((candidate) => {
            const selected = candidate.checkpointTurnCount === checkpoint.checkpointTurnCount;
            return (
              <Pressable
                key={`${candidate.turnId}-${candidate.checkpointTurnCount}`}
                onPress={() => setSelectedTurnCount(candidate.checkpointTurnCount)}
                style={[
                  styles.checkpointChip,
                  {
                    backgroundColor: selected
                      ? withAlpha(colors.primary, 0.14)
                      : colors.surfaceSecondary,
                    borderColor: selected ? withAlpha(colors.primary, 0.32) : colors.elevatedBorder,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.checkpointChipLabel,
                    { color: selected ? colors.primary : colors.secondaryLabel },
                  ]}
                >
                  Turn {candidate.checkpointTurnCount}
                </Text>
                <Text style={[styles.checkpointChipMeta, { color: colors.tertiaryLabel }]}>
                  {candidate.files.length} files
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={styles.diffActions}>
        <Pressable
          disabled={loadingPatch}
          onPress={() => void loadPatch()}
          style={[
            styles.approvalButton,
            {
              backgroundColor: colors.primary,
            },
            loadingPatch && styles.disabledButton,
          ]}
        >
          <Text style={[styles.approvalButtonLabel, { color: colors.primaryForeground }]}>
            {patch ? "Reload patch" : loadingPatch ? "Loading patch..." : "Load patch"}
          </Text>
        </Pressable>
        <Pressable
          disabled={revertingCheckpoint}
          onPress={requestRevert}
          style={[
            styles.approvalButton,
            {
              backgroundColor: withAlpha(colors.red, 0.12),
              borderColor: withAlpha(colors.red, 0.18),
              borderWidth: 1,
            },
            revertingCheckpoint && styles.disabledButton,
          ]}
        >
          <Text style={[styles.approvalButtonLabel, { color: colors.red }]}>
            {revertingCheckpoint
              ? usesTranscriptRebuildRestore(provider)
                ? "Restoring..."
                : "Reverting..."
              : usesTranscriptRebuildRestore(provider)
                ? "Restore"
                : "Revert"}
          </Text>
        </Pressable>
      </View>
      {patchError ? (
        <Text style={[styles.approvalError, { color: colors.red }]}>{patchError}</Text>
      ) : null}
      {revertError ? (
        <Text style={[styles.approvalError, { color: colors.red }]}>{revertError}</Text>
      ) : null}
      <View style={styles.fileList}>
        {checkpoint.files.map((file) => (
          <View
            key={`${checkpoint.turnId}-${file.path}`}
            style={[
              styles.fileRow,
              {
                borderColor: colors.elevatedBorder,
                backgroundColor: colors.surfaceSecondary,
              },
            ]}
          >
            <Text style={[styles.filePath, { color: colors.foreground }]} numberOfLines={1}>
              {file.path}
            </Text>
            <Text style={[styles.fileMeta, { color: colors.secondaryLabel }]}>
              +{file.additions} / -{file.deletions}
            </Text>
          </View>
        ))}
      </View>
      {patch ? (
        <View
          style={[
            styles.patchBox,
            {
              borderColor: colors.elevatedBorder,
              backgroundColor: colors.surfaceSecondary,
            },
          ]}
        >
          <Text style={[styles.patchMeta, { color: colors.secondaryLabel }]}>
            {patch.length > MOBILE_DIFF_PREVIEW_LIMIT
              ? `Showing first ${MOBILE_DIFF_PREVIEW_LIMIT.toLocaleString()} characters`
              : "Patch"}
          </Text>
          <ScrollView horizontal={!diffWordWrap} showsHorizontalScrollIndicator={!diffWordWrap}>
            <Text
              style={[
                styles.patchText,
                { color: colors.foreground },
                diffWordWrap && styles.patchTextWrapped,
              ]}
            >
              {patch.length > MOBILE_DIFF_PREVIEW_LIMIT
                ? `${patch.slice(0, MOBILE_DIFF_PREVIEW_LIMIT)}\n\n[Diff truncated for mobile preview]`
                : patch}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </Panel>
  );
}

function hasUserInputAnswer(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== null;
}

function TodoPanel({
  activities,
  proposedPlan,
  canImplementPlan,
  implementingPlanMode,
  planActionError,
  pendingApprovals,
  respondingApprovalId,
  approvalError,
  pendingUserInputs,
  respondingUserInputId,
  userInputDraftAnswers,
  userInputError,
  handoffProviders,
  handoffProvider,
  handoffMode,
  handoffInFlight,
  handoffError,
  onApprovalResponse,
  onUserInputAnswerChange,
  onUserInputOptionToggle,
  onUserInputResponse,
  onImplementPlanInCurrentThread,
  onImplementPlanInNewThread,
  onHandoffProviderChange,
  onHandoffModeChange,
  onHandoff,
  onArchiveThread,
  onDeleteThread,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  proposedPlan: OrchestrationProposedPlan | null;
  canImplementPlan: boolean;
  implementingPlanMode: "current" | "new" | null;
  planActionError: string | null;
  pendingApprovals: ReadonlyArray<PendingApproval>;
  respondingApprovalId: ApprovalRequestId | null;
  approvalError: string | null;
  pendingUserInputs: ReadonlyArray<PendingUserInput>;
  respondingUserInputId: ApprovalRequestId | null;
  userInputDraftAnswers: UserInputDraftAnswers;
  userInputError: string | null;
  handoffProviders: ReadonlyArray<ServerProvider>;
  handoffProvider: ProviderKind | null;
  handoffMode: ThreadHandoffMode;
  handoffInFlight: boolean;
  handoffError: string | null;
  onApprovalResponse: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onUserInputAnswerChange: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    value: unknown,
  ) => void;
  onUserInputOptionToggle: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    optionLabel: string,
  ) => void;
  onUserInputResponse: (requestId: ApprovalRequestId) => Promise<void>;
  onImplementPlanInCurrentThread: () => Promise<void>;
  onImplementPlanInNewThread: () => Promise<void>;
  onHandoffProviderChange: (provider: ProviderKind) => void;
  onHandoffModeChange: (mode: ThreadHandoffMode) => void;
  onHandoff: () => Promise<void>;
  onArchiveThread: () => void;
  onDeleteThread: () => void;
}) {
  const { colors } = useTheme();
  const planTitle = proposedPlan
    ? (proposedPlanTitle(proposedPlan.planMarkdown) ?? "Proposed plan")
    : null;
  const planPreview = proposedPlan ? buildProposedPlanPreview(proposedPlan.planMarkdown) : null;

  return (
    <Panel>
      <Text style={[styles.placeholderTitle, { color: colors.foreground }]}>Thread focus</Text>
      <Text style={[styles.placeholderText, { color: colors.secondaryLabel }]}>
        {proposedPlan
          ? "Review or implement the proposed plan from mobile."
          : "Approvals, errors, and tool activity appear here as the run evolves."}
      </Text>

      {proposedPlan && planTitle && planPreview ? (
        <View
          style={[
            styles.proposedPlanCard,
            {
              backgroundColor: withAlpha(colors.green, 0.1),
              borderColor: withAlpha(colors.green, 0.24),
            },
          ]}
        >
          <Text style={[styles.proposedPlanEyebrow, { color: colors.green }]}>Plan</Text>
          <Text style={[styles.proposedPlanTitle, { color: colors.foreground }]}>{planTitle}</Text>
          <Text style={[styles.proposedPlanPreview, { color: colors.secondaryLabel }]}>
            {planPreview}
          </Text>
          <View style={styles.proposedPlanActions}>
            <Pressable
              disabled={!canImplementPlan || implementingPlanMode !== null}
              onPress={() => void onImplementPlanInCurrentThread()}
              style={[
                styles.approvalButton,
                { backgroundColor: colors.primary },
                (!canImplementPlan || implementingPlanMode !== null) && styles.disabledButton,
              ]}
            >
              <Text style={[styles.approvalButtonLabel, { color: colors.primaryForeground }]}>
                {implementingPlanMode === "current" ? "Starting..." : "Implement here"}
              </Text>
            </Pressable>
            <Pressable
              disabled={!canImplementPlan || implementingPlanMode !== null}
              onPress={() => void onImplementPlanInNewThread()}
              style={[
                styles.approvalButton,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.elevatedBorder,
                  borderWidth: 1,
                },
                (!canImplementPlan || implementingPlanMode !== null) && styles.disabledButton,
              ]}
            >
              <Text style={[styles.approvalButtonLabel, { color: colors.foreground }]}>
                {implementingPlanMode === "new" ? "Creating..." : "New thread"}
              </Text>
            </Pressable>
          </View>
          {planActionError ? (
            <Text style={[styles.approvalError, { color: colors.red }]}>{planActionError}</Text>
          ) : null}
        </View>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <View style={styles.approvalList}>
          {pendingApprovals.map((approval) => {
            const isResponding = respondingApprovalId === approval.requestId;
            return (
              <View
                key={approval.requestId}
                style={[
                  styles.approvalCard,
                  {
                    borderColor: withAlpha(colors.orange, 0.22),
                    backgroundColor: withAlpha(colors.orange, 0.1),
                  },
                ]}
              >
                <Text style={[styles.approvalKind, { color: colors.orange }]}>
                  {approval.kind.replace("-", " ")} approval
                </Text>
                <Text style={[styles.approvalSummary, { color: colors.foreground }]}>
                  {approval.summary}
                </Text>
                {approval.detail ? (
                  <Text style={[styles.approvalDetail, { color: colors.secondaryLabel }]}>
                    {approval.detail}
                  </Text>
                ) : null}
                <View style={styles.approvalActions}>
                  <Pressable
                    disabled={isResponding}
                    onPress={() => void onApprovalResponse(approval.requestId, "accept")}
                    style={[
                      styles.approvalButton,
                      { backgroundColor: colors.primary },
                      isResponding && styles.disabledButton,
                    ]}
                  >
                    <Text style={[styles.approvalButtonLabel, { color: colors.primaryForeground }]}>
                      Allow
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={isResponding}
                    onPress={() => void onApprovalResponse(approval.requestId, "acceptForSession")}
                    style={[
                      styles.approvalButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                        borderWidth: 1,
                      },
                      isResponding && styles.disabledButton,
                    ]}
                  >
                    <Text style={[styles.approvalButtonLabel, { color: colors.foreground }]}>
                      Session
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={isResponding}
                    onPress={() => void onApprovalResponse(approval.requestId, "decline")}
                    style={[
                      styles.approvalButton,
                      {
                        backgroundColor: withAlpha(colors.red, 0.12),
                        borderColor: withAlpha(colors.red, 0.18),
                        borderWidth: 1,
                      },
                      isResponding && styles.disabledButton,
                    ]}
                  >
                    <Text style={[styles.approvalButtonLabel, { color: colors.red }]}>Deny</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
          {approvalError ? (
            <Text style={[styles.approvalError, { color: colors.red }]}>{approvalError}</Text>
          ) : null}
        </View>
      ) : null}

      {pendingUserInputs.length > 0 ? (
        <View style={styles.userInputList}>
          {pendingUserInputs.map((request) => {
            const draftAnswers = userInputDraftAnswers[request.requestId] ?? {};
            const isResponding = respondingUserInputId === request.requestId;
            const canSubmit = request.questions.every((question) =>
              hasUserInputAnswer(draftAnswers[question.id]),
            );

            return (
              <View
                key={request.requestId}
                style={[
                  styles.userInputCard,
                  {
                    borderColor: withAlpha(colors.primary, 0.22),
                    backgroundColor: withAlpha(colors.primary, 0.1),
                  },
                ]}
              >
                <Text style={[styles.userInputKind, { color: colors.primary }]}>
                  Input required
                </Text>
                {request.questions.map((question, index) => {
                  const answer = draftAnswers[question.id];
                  return (
                    <View key={question.id} style={styles.userInputQuestion}>
                      <Text style={[styles.userInputHeader, { color: colors.tertiaryLabel }]}>
                        {question.header || `Question ${index + 1}`}
                      </Text>
                      <Text style={[styles.userInputPrompt, { color: colors.foreground }]}>
                        {question.question}
                      </Text>
                      {question.options.length > 0 ? (
                        <View style={styles.userInputOptions}>
                          {question.options.map((option) => {
                            const selected = question.multiSelect
                              ? Array.isArray(answer) && answer.includes(option.label)
                              : answer === option.label;
                            return (
                              <Pressable
                                key={option.label}
                                onPress={() =>
                                  onUserInputOptionToggle(request.requestId, question, option.label)
                                }
                                style={[
                                  styles.userInputOption,
                                  {
                                    backgroundColor: selected ? colors.primary : colors.surface,
                                    borderColor: selected ? colors.primary : colors.elevatedBorder,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.userInputOptionLabel,
                                    {
                                      color: selected
                                        ? colors.primaryForeground
                                        : colors.foreground,
                                    },
                                  ]}
                                >
                                  {option.label}
                                </Text>
                                {option.description !== option.label ? (
                                  <Text
                                    style={[
                                      styles.userInputOptionDescription,
                                      {
                                        color: selected
                                          ? withAlpha(colors.primaryForeground, 0.72)
                                          : colors.secondaryLabel,
                                      },
                                    ]}
                                  >
                                    {option.description}
                                  </Text>
                                ) : null}
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : (
                        <TextInput
                          value={typeof answer === "string" ? answer : ""}
                          onChangeText={(value) =>
                            onUserInputAnswerChange(request.requestId, question, value)
                          }
                          placeholder="Type your answer"
                          placeholderTextColor={colors.muted}
                          multiline
                          style={[
                            styles.userInputText,
                            {
                              color: colors.foreground,
                              backgroundColor: colors.surface,
                              borderColor: colors.elevatedBorder,
                            },
                          ]}
                        />
                      )}
                    </View>
                  );
                })}
                <Pressable
                  disabled={!canSubmit || isResponding}
                  onPress={() => void onUserInputResponse(request.requestId)}
                  style={[
                    styles.userInputSubmit,
                    { backgroundColor: colors.primary },
                    (!canSubmit || isResponding) && styles.disabledButton,
                  ]}
                >
                  <Text style={[styles.userInputSubmitLabel, { color: colors.primaryForeground }]}>
                    Submit answers
                  </Text>
                </Pressable>
              </View>
            );
          })}
          {userInputError ? (
            <Text style={[styles.approvalError, { color: colors.red }]}>{userInputError}</Text>
          ) : null}
        </View>
      ) : null}

      {handoffProviders.length > 0 ? (
        <View
          style={[
            styles.handoffPanel,
            {
              backgroundColor: colors.surfaceSecondary,
              borderColor: colors.elevatedBorder,
            },
          ]}
        >
          <Text style={[styles.handoffTitle, { color: colors.foreground }]}>Handoff</Text>
          <Text style={[styles.handoffBody, { color: colors.secondaryLabel }]}>
            Continue this thread with another provider.
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.handoffStrip}
          >
            {handoffProviders.map((provider) => {
              const selected = provider.provider === handoffProvider;
              return (
                <Pressable
                  key={provider.provider}
                  onPress={() => onHandoffProviderChange(provider.provider)}
                  style={[
                    styles.handoffChip,
                    {
                      backgroundColor: selected ? withAlpha(colors.primary, 0.12) : colors.surface,
                      borderColor: selected
                        ? withAlpha(colors.primary, 0.38)
                        : colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.handoffChipLabel,
                      { color: selected ? colors.primary : colors.foreground },
                    ]}
                  >
                    {PROVIDER_DISPLAY_NAMES[provider.provider]}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.handoffModeRow}>
            {HANDOFF_MODES.map((mode) => {
              const selected = mode.value === handoffMode;
              return (
                <Pressable
                  key={mode.value}
                  onPress={() => onHandoffModeChange(mode.value)}
                  style={[
                    styles.handoffModeChip,
                    {
                      backgroundColor: selected ? withAlpha(colors.primary, 0.12) : colors.surface,
                      borderColor: selected
                        ? withAlpha(colors.primary, 0.38)
                        : colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.handoffModeLabel,
                      { color: selected ? colors.primary : colors.foreground },
                    ]}
                  >
                    {mode.label}
                  </Text>
                  <Text style={[styles.handoffModeDescription, { color: colors.secondaryLabel }]}>
                    {mode.description}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            disabled={!handoffProvider || handoffInFlight}
            onPress={() => void onHandoff()}
            style={[
              styles.handoffButton,
              { backgroundColor: colors.primary },
              (!handoffProvider || handoffInFlight) && styles.disabledButton,
            ]}
          >
            {handoffInFlight ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text style={[styles.handoffButtonLabel, { color: colors.primaryForeground }]}>
                Create handoff thread
              </Text>
            )}
          </Pressable>
          {handoffError ? (
            <Text style={[styles.approvalError, { color: colors.red }]}>{handoffError}</Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={[
          styles.threadActionsPanel,
          {
            backgroundColor: colors.surfaceSecondary,
            borderColor: colors.elevatedBorder,
          },
        ]}
      >
        <Text style={[styles.threadActionsTitle, { color: colors.foreground }]}>
          Thread actions
        </Text>
        <View style={styles.threadActionsRow}>
          <Pressable
            onPress={() => void onArchiveThread()}
            style={[
              styles.threadActionButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
              },
            ]}
          >
            <Archive size={15} color={colors.foreground} strokeWidth={2.1} />
            <Text style={[styles.threadActionLabel, { color: colors.foreground }]}>Archive</Text>
          </Pressable>
          <Pressable
            onPress={onDeleteThread}
            style={[
              styles.threadActionButton,
              {
                backgroundColor: withAlpha(colors.red, 0.12),
                borderColor: withAlpha(colors.red, 0.2),
              },
            ]}
          >
            <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
            <Text style={[styles.threadActionLabel, { color: colors.red }]}>Delete</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.fileList}>
        {activities.length === 0 ? (
          <Text style={[styles.placeholderText, { color: colors.muted }]}>No active items.</Text>
        ) : (
          activities.map((activity) => (
            <View
              key={activity.id}
              style={[
                styles.todoRow,
                {
                  borderColor: colors.elevatedBorder,
                  backgroundColor: colors.surfaceSecondary,
                },
              ]}
            >
              <Text style={[styles.todoKind, { color: colors.tertiaryLabel }]}>
                {activity.kind.replaceAll(".", " ")}
              </Text>
              <Text style={[styles.todoSummary, { color: colors.foreground }]}>
                {activity.summary}
              </Text>
            </View>
          ))
        )}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  loadingRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    paddingHorizontal: Layout.pagePadding,
    paddingBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
    elevation: 0,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.24,
    textTransform: "uppercase",
  },
  headerTitle: {
    marginTop: 6,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  headerSubtitle: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  stopButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  stopLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  summaryPanel: {
    marginTop: 18,
  },
  summaryTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryMeta: {
    fontSize: 12,
    fontWeight: "700",
  },
  threadErrorBanner: {
    marginTop: 12,
    minHeight: 54,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  threadErrorText: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  threadErrorDismissButton: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  threadErrorDismissLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  panelTabs: {
    marginTop: 16,
    flexDirection: "row",
    gap: 10,
  },
  panelTab: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  panelTabLabel: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: -0.1,
  },
  threadModeGrid: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },
  threadModeGroup: {
    flex: 1,
    gap: 7,
  },
  threadModeLabel: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "900",
    textTransform: "uppercase",
  },
  threadModeRow: {
    flexDirection: "row",
    gap: 7,
  },
  threadModeChip: {
    flex: 1,
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  threadModeChipLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  threadModelGroup: {
    marginTop: 12,
    gap: 7,
  },
  threadModelStrip: {
    gap: 8,
    paddingBottom: 2,
  },
  threadModelChip: {
    maxWidth: 220,
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  threadModelChipLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  threadTraitBlock: {
    gap: 6,
  },
  threadTraitLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "800",
  },
  threadTraitChip: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  threadTraitChipLabel: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
  },
  content: {
    paddingHorizontal: Layout.pagePadding,
    gap: 14,
  },
  chatPanel: {
    gap: 12,
  },
  messageCard: {
    borderWidth: 1,
    borderRadius: Radius.card,
    paddingHorizontal: 16,
    paddingVertical: 15,
    maxWidth: "92%",
  },
  userMessage: {
    alignSelf: "flex-end",
  },
  assistantMessage: {
    alignSelf: "flex-start",
  },
  messageRole: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  messageText: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
  },
  messageLinks: {
    marginTop: 12,
    gap: 8,
  },
  messageLink: {
    minHeight: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  messageLinkLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  queueHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  queueMeta: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 18,
  },
  queueClearButton: {
    minHeight: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  queueClearLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  queueList: {
    marginTop: 14,
    gap: 10,
  },
  queueRow: {
    minHeight: 72,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  queueCopy: {
    flex: 1,
    minWidth: 0,
  },
  queueTitle: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  queuePrompt: {
    marginTop: 5,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
  queueActions: {
    alignItems: "center",
    gap: 8,
  },
  queueSteerButton: {
    minWidth: 72,
    minHeight: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  queueSteerLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  queueIconActions: {
    flexDirection: "row",
    gap: 8,
  },
  queueIconButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  toolList: {
    marginTop: 14,
    gap: 10,
  },
  toolRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toolSummary: {
    fontSize: 14,
    lineHeight: 20,
  },
  placeholderTitle: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  placeholderMeta: {
    marginTop: 8,
    fontSize: 13,
  },
  placeholderText: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
  },
  proposedPlanCard: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  proposedPlanEyebrow: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  proposedPlanTitle: {
    marginTop: 7,
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  proposedPlanPreview: {
    marginTop: 9,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  proposedPlanActions: {
    marginTop: 13,
    flexDirection: "row",
    gap: 8,
  },
  approvalList: {
    marginTop: 16,
    gap: 10,
  },
  approvalCard: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  approvalKind: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.18,
    textTransform: "uppercase",
  },
  approvalSummary: {
    marginTop: 7,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
  },
  approvalDetail: {
    marginTop: 7,
    fontSize: 13,
    lineHeight: 19,
  },
  approvalActions: {
    marginTop: 12,
    flexDirection: "row",
    gap: 8,
  },
  approvalButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  approvalButtonLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  disabledButton: {
    opacity: 0.58,
  },
  approvalError: {
    fontSize: 13,
    lineHeight: 18,
  },
  userInputList: {
    marginTop: 16,
    gap: 10,
  },
  userInputCard: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  userInputKind: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.18,
    textTransform: "uppercase",
  },
  userInputQuestion: {
    marginTop: 14,
  },
  userInputHeader: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.18,
    textTransform: "uppercase",
  },
  userInputPrompt: {
    marginTop: 6,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "700",
  },
  userInputOptions: {
    marginTop: 10,
    gap: 8,
  },
  userInputOption: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 13,
    paddingVertical: 10,
    justifyContent: "center",
  },
  userInputOptionLabel: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  userInputOptionDescription: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
  },
  userInputText: {
    marginTop: 10,
    minHeight: 88,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 13,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  userInputSubmit: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  userInputSubmitLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  handoffPanel: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  handoffTitle: {
    fontSize: 17,
    lineHeight: 21,
    fontWeight: "800",
    letterSpacing: -0.35,
  },
  handoffBody: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
  },
  handoffStrip: {
    gap: 8,
    paddingTop: 12,
    paddingBottom: 2,
  },
  handoffChip: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffChipLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  handoffModeRow: {
    marginTop: 10,
    flexDirection: "row",
    gap: 8,
  },
  handoffModeChip: {
    flex: 1,
    minHeight: 54,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    justifyContent: "center",
  },
  handoffModeLabel: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  handoffModeDescription: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 16,
  },
  handoffButton: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  handoffButtonLabel: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  threadActionsPanel: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  threadActionsTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  threadActionsRow: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },
  threadActionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  threadActionLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  fileList: {
    marginTop: 16,
    gap: 10,
  },
  fileRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  filePath: {
    fontSize: 14,
    fontWeight: "700",
  },
  fileMeta: {
    marginTop: 5,
    fontSize: 12,
    fontWeight: "600",
  },
  checkpointStrip: {
    paddingTop: 14,
    gap: 8,
  },
  checkpointChip: {
    minWidth: 86,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: "center",
  },
  checkpointChipLabel: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
  },
  checkpointChipMeta: {
    marginTop: 3,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
  },
  diffActions: {
    marginTop: 14,
    flexDirection: "row",
    gap: 8,
  },
  patchBox: {
    marginTop: 14,
    borderWidth: 1,
    borderRadius: Radius.input,
    padding: 12,
  },
  patchMeta: {
    marginBottom: 10,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  patchText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 11,
    lineHeight: 16,
  },
  patchTextWrapped: {
    flexShrink: 1,
  },
  todoRow: {
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  todoKind: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  todoSummary: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 20,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Layout.pagePadding,
    paddingTop: 12,
  },
  connectionRecoveryBanner: {
    marginBottom: 10,
    minHeight: 72,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  connectionRecoveryCopy: {
    flex: 1,
    minWidth: 0,
  },
  connectionRecoveryTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  connectionRecoveryBody: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  connectionReconnectButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  connectionReconnectLabel: {
    fontSize: 13,
    fontWeight: "800",
  },
  terminalContextStrip: {
    marginBottom: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  terminalContextChip: {
    maxWidth: "78%",
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingLeft: 10,
    paddingRight: 5,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  terminalContextLabel: {
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  terminalContextRemove: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalContextClear: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalContextClearLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  composerField: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
    borderWidth: 1,
    borderRadius: Radius.panel,
    paddingLeft: 16,
    paddingRight: 10,
    paddingVertical: 10,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.1,
    shadowRadius: 28,
    elevation: 0,
  },
  textInput: {
    flex: 1,
    minHeight: 24,
    maxHeight: 120,
    fontSize: 15,
    lineHeight: 21,
    paddingTop: 4,
    paddingBottom: 4,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
