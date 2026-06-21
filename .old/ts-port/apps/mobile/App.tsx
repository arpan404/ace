import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationThread,
  ProjectEntry,
  TerminalEvent,
  ThreadId,
} from "@ace/contracts";
import {
  createThreadSessionStopCommand,
  createThreadTurnInterruptCommand,
  createThreadTurnStartCommand,
} from "@ace/shared/orchestrationCommands";
import { randomUUID } from "@ace/shared/ids";
import { CameraView, type BarcodeScanningResult, useCameraPermissions } from "expo-camera";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import type { WebViewErrorEvent } from "react-native-webview/lib/WebViewTypes";
import {
  createHostInstance,
  parseHostConnectionQrPayload,
  requestPairingClaim,
  waitForPairingApproval,
  type HostInstance,
  wsUrlToBrowserBaseUrl,
} from "./src/hostInstances";
import { notificationFromDomainEvent } from "./src/notifications";
import { resolveProjectAgentStats } from "./src/projectAgentStats";
import { createMobileWsClient, type MobileWsClient } from "./src/rpc/mobileWsClient";
import {
  Blocks,
  FileCode2,
  Globe,
  MessagesSquare,
  Terminal,
  type LucideIcon,
} from "lucide-react-native";

const HOSTS_STORAGE_KEY = "ace.mobile.hosts.v2";
const ACTIVE_HOST_STORAGE_KEY = "ace.mobile.active-host.v2";
const MAX_MESSAGES_VISIBLE = 60;
const MAX_ACTIVITIES_VISIBLE = 40;
const NOTIFICATION_EVENT_CACHE_LIMIT = 800;
const MAX_TERMINAL_OUTPUT_CHARS = 160_000;
const TERMINAL_ID = "default";
const PAIRING_REQUEST_TIMEOUT_MS = 10_000;
const MOBILE_THEME = {
  background: "#090b10",
  surface: "#11141b",
  surfaceElevated: "#171b24",
  activeSurface: "#1e2430",
  border: "#2a3140",
  borderStrong: "#374154",
  foreground: "#ededed",
  subtleForeground: "#c1c7d3",
  mutedForeground: "#949cab",
  primary: "#9ca3af",
  primaryForeground: "#101319",
  inputSurface: "#12161e",
  dangerSurface: "#3a1f1f",
  dangerBorder: "#734545",
  dangerForeground: "#ffc9c9",
  terminalSurface: "#0c0f14",
  terminalForeground: "#bfe6c0",
} as const;

type AppTab = "projects" | "threads" | "browser" | "editor" | "terminal";
type ConnectionStatus = "disconnected" | "connecting" | "connected";
type WorkflowAction = "sending" | "interrupting" | "stopping" | null;

const TAB_ORDER: ReadonlyArray<AppTab> = ["projects", "threads", "browser", "editor", "terminal"];

const TAB_LABEL: Record<AppTab, string> = {
  projects: "Projects",
  threads: "Threads",
  browser: "Browser",
  editor: "Editor",
  terminal: "Terminal",
};

const TAB_ICON: Record<AppTab, LucideIcon> = {
  projects: Blocks,
  threads: MessagesSquare,
  browser: Globe,
  editor: FileCode2,
  terminal: Terminal,
};

interface HostFormState {
  readonly name: string;
  readonly wsUrl: string;
  readonly authToken: string;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function formatRelativeDate(isoDate: string | null | undefined): string {
  if (!isoDate) {
    return "n/a";
  }
  const value = new Date(isoDate);
  if (Number.isNaN(value.getTime())) {
    return isoDate;
  }
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sortedCopy<T>(values: ReadonlyArray<T>, compare: (left: T, right: T) => number): Array<T> {
  const result = [...values];
  for (let index = 1; index < result.length; index += 1) {
    const candidate = result[index];
    let insertionIndex = index - 1;
    while (insertionIndex >= 0 && compare(result[insertionIndex] as T, candidate as T) > 0) {
      result[insertionIndex + 1] = result[insertionIndex] as T;
      insertionIndex -= 1;
    }
    result[insertionIndex + 1] = candidate as T;
  }
  return result;
}

function reversedCopy<T>(values: ReadonlyArray<T>): Array<T> {
  const result: T[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    result.push(values[index] as T);
  }
  return result;
}

function sortProjects(projects: ReadonlyArray<OrchestrationProject>): OrchestrationProject[] {
  return sortedCopy(
    projects.filter((project) => project.deletedAt === null),
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

function sortAllThreads(threads: ReadonlyArray<OrchestrationThread>): OrchestrationThread[] {
  return sortedCopy(
    threads.filter((thread) => thread.deletedAt === null),
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

function summarizeThread(thread: OrchestrationThread): string {
  const latestMessage = sortedCopy(thread.messages, (left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  ).at(0);
  if (!latestMessage) {
    return "No messages yet";
  }
  const text = latestMessage.text.trim();
  if (text.length <= 96) {
    return text || `${latestMessage.role} message`;
  }
  return `${text.slice(0, 95)}…`;
}

function pickVisibleMessages(thread: OrchestrationThread) {
  return sortedCopy(thread.messages, (left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  ).slice(-MAX_MESSAGES_VISIBLE);
}

function pickVisibleActivities(thread: OrchestrationThread) {
  return sortedCopy(thread.activities, (left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  ).slice(0, MAX_ACTIVITIES_VISIBLE);
}

function trimEventCache(cache: Set<string>): void {
  if (cache.size <= NOTIFICATION_EVENT_CACHE_LIMIT) {
    return;
  }
  const oldestEventId = cache.values().next().value;
  if (oldestEventId) {
    cache.delete(oldestEventId);
  }
}

function normalizeBrowserAddress(rawAddress: string): string {
  const trimmed = rawAddress.trim();
  if (trimmed.length === 0) {
    throw new Error("Browser URL is required.");
  }
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("about:")
  ) {
    return new URL(trimmed).toString();
  }
  return new URL(`http://${trimmed}`).toString();
}

function createInitialHostForm(activeHost: HostInstance | null): HostFormState {
  return {
    name: "",
    wsUrl: activeHost?.wsUrl ?? "",
    authToken: activeHost?.authToken ?? "",
  };
}

function truncateTerminalOutput(text: string): string {
  if (text.length <= MAX_TERMINAL_OUTPUT_CHARS) {
    return text;
  }
  return text.slice(text.length - MAX_TERMINAL_OUTPUT_CHARS);
}

function quickTerminalKeySequence(
  key: "esc" | "tab" | "up" | "down" | "left" | "right" | "ctrl-c",
): string {
  switch (key) {
    case "esc":
      return "\u001B";
    case "tab":
      return "\t";
    case "up":
      return "\u001B[A";
    case "down":
      return "\u001B[B";
    case "left":
      return "\u001B[D";
    case "right":
      return "\u001B[C";
    case "ctrl-c":
      return "\u0003";
  }
}

function uniquePush(items: ReadonlyArray<string>, next: string, maxSize: number): string[] {
  const trimmed = next.trim();
  if (trimmed.length === 0) {
    return [...items];
  }
  const withoutExisting = items.filter((item) => item !== trimmed);
  return [...withoutExisting, trimmed].slice(-maxSize);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("projects");
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [hosts, setHosts] = useState<HostInstance[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [providerCount, setProviderCount] = useState<number>(0);
  const [snapshot, setSnapshot] = useState<Awaited<
    ReturnType<MobileWsClient["orchestration"]["getSnapshot"]>
  > | null>(null);

  const [hostForm, setHostForm] = useState<HostFormState>({
    name: "",
    wsUrl: "",
    authToken: "",
  });

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadDetailThreadId, setThreadDetailThreadId] = useState<string | null>(null);
  const [workflowAction, setWorkflowAction] = useState<WorkflowAction>(null);
  const [promptInput, setPromptInput] = useState("");

  const [browserAddressInput, setBrowserAddressInput] = useState("");
  const [browserCurrentUrl, setBrowserCurrentUrl] = useState("");

  const [editorProjectId, setEditorProjectId] = useState<string | null>(null);
  const [editorEntries, setEditorEntries] = useState<ReadonlyArray<ProjectEntry>>([]);
  const [editorSelectedFilePath, setEditorSelectedFilePath] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [editorOriginalContent, setEditorOriginalContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);

  const [terminalThreadId, setTerminalThreadId] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalStatus, setTerminalStatus] = useState("idle");
  const [terminalTitle, setTerminalTitle] = useState("Terminal");
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);

  const [scannerVisible, setScannerVisible] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const clientRef = useRef<MobileWsClient | null>(null);
  const connectionCleanupRef = useRef<(() => void) | null>(null);
  const domainEventCleanupRef = useRef<(() => void) | null>(null);
  const terminalEventCleanupRef = useRef<(() => void) | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const notificationEventIdsRef = useRef(new Set<string>());
  const terminalThreadIdRef = useRef<string | null>(null);

  const activeHost = useMemo(
    () => hosts.find((host) => host.id === activeHostId) ?? null,
    [hosts, activeHostId],
  );
  const projects = useMemo(() => (snapshot ? sortProjects(snapshot.projects) : []), [snapshot]);
  const allThreads = useMemo(() => (snapshot ? sortAllThreads(snapshot.threads) : []), [snapshot]);
  const threadDetail = useMemo(
    () => allThreads.find((thread) => thread.id === threadDetailThreadId) ?? null,
    [allThreads, threadDetailThreadId],
  );
  const filteredThreads = useMemo(() => {
    if (!selectedProjectId) {
      return allThreads;
    }
    return allThreads.filter((thread) => thread.projectId === selectedProjectId);
  }, [allThreads, selectedProjectId]);
  const visibleMessages = useMemo(
    () => (threadDetail ? pickVisibleMessages(threadDetail) : []),
    [threadDetail],
  );
  const visibleActivities = useMemo(
    () => (threadDetail ? pickVisibleActivities(threadDetail) : []),
    [threadDetail],
  );
  const editorFiles = useMemo(
    () =>
      sortedCopy(
        editorEntries.filter((entry) => entry.kind === "file"),
        (left, right) => left.path.localeCompare(right.path),
      ),
    [editorEntries],
  );
  const terminalSuggestions = useMemo(() => {
    const prefix = terminalInput.trim();
    if (prefix.length === 0) {
      return reversedCopy(terminalHistory.slice(-5));
    }
    return reversedCopy(terminalHistory.filter((item) => item.startsWith(prefix))).slice(0, 5);
  }, [terminalHistory, terminalInput]);
  const editorHasUnsavedChanges = editorContent !== editorOriginalContent;

  useEffect(() => {
    terminalThreadIdRef.current = terminalThreadId;
  }, [terminalThreadId]);

  const persistHosts = useCallback(
    async (nextHosts: HostInstance[], nextActiveHostId: string | null) => {
      setHosts(nextHosts);
      setActiveHostId(nextActiveHostId);
      await Promise.all([
        AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(nextHosts)),
        AsyncStorage.setItem(ACTIVE_HOST_STORAGE_KEY, nextActiveHostId ?? ""),
      ]);
    },
    [],
  );

  const teardownClient = useCallback(async (): Promise<void> => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    refreshQueuedRef.current = false;
    connectionCleanupRef.current?.();
    connectionCleanupRef.current = null;
    domainEventCleanupRef.current?.();
    domainEventCleanupRef.current = null;
    terminalEventCleanupRef.current?.();
    terminalEventCleanupRef.current = null;

    const activeClient = clientRef.current;
    clientRef.current = null;
    if (activeClient) {
      await activeClient.dispose();
    }
  }, []);

  useEffect(
    () => () => {
      void teardownClient();
    },
    [teardownClient],
  );

  const appendTerminalOutput = useCallback((chunk: string): void => {
    setTerminalOutput((previous) => truncateTerminalOutput(`${previous}${chunk}`));
  }, []);

  const handleTerminalEvent = useCallback(
    (event: TerminalEvent): void => {
      const activeThreadId = terminalThreadIdRef.current;
      if (
        !activeThreadId ||
        event.threadId !== activeThreadId ||
        event.terminalId !== TERMINAL_ID
      ) {
        return;
      }
      switch (event.type) {
        case "started":
          setTerminalStatus(event.snapshot.status);
          setTerminalTitle(event.snapshot.title ?? "Terminal");
          setTerminalCwd(event.snapshot.cwd);
          setTerminalOutput(truncateTerminalOutput(event.snapshot.history));
          return;
        case "restarted":
          setTerminalStatus(event.snapshot.status);
          setTerminalTitle(event.snapshot.title ?? "Terminal");
          setTerminalCwd(event.snapshot.cwd);
          setTerminalOutput(truncateTerminalOutput(event.snapshot.history));
          return;
        case "output":
          appendTerminalOutput(event.data);
          return;
        case "title":
          setTerminalTitle(event.title ?? "Terminal");
          return;
        case "exited":
          setTerminalStatus("exited");
          appendTerminalOutput(
            `\n[terminal exited: code=${String(event.exitCode)} signal=${String(event.exitSignal)}]\n`,
          );
          return;
        case "error":
          setTerminalStatus("error");
          appendTerminalOutput(`\n[terminal error] ${event.message}\n`);
          return;
        case "cleared":
          setTerminalOutput("");
          return;
        case "activity":
          return;
      }
    },
    [appendTerminalOutput],
  );

  const refreshSnapshot = useCallback(
    async (clientOverride?: MobileWsClient): Promise<void> => {
      const activeClient = clientOverride ?? clientRef.current;
      if (!activeClient) {
        return;
      }
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
        return;
      }
      refreshInFlightRef.current = true;
      try {
        const nextSnapshot = await activeClient.orchestration.getSnapshot(
          threadDetailThreadId ? { hydrateThreadId: threadDetailThreadId as ThreadId } : {},
        );
        setSnapshot(nextSnapshot);
      } catch (error) {
        setStatusMessage(`Snapshot refresh failed: ${formatError(error)}`);
      } finally {
        refreshInFlightRef.current = false;
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          void refreshSnapshot(activeClient);
        }
      }
    },
    [threadDetailThreadId],
  );

  const refreshServerConfig = useCallback(
    async (clientOverride?: MobileWsClient): Promise<void> => {
      const activeClient = clientOverride ?? clientRef.current;
      if (!activeClient) {
        return;
      }
      try {
        const config = await activeClient.server.getConfig();
        setProviderCount(config.providers.length);
      } catch (error) {
        setStatusMessage(`Provider sync failed: ${formatError(error)}`);
      }
    },
    [],
  );

  const queueRefresh = useCallback(
    (delayMs = 160): void => {
      if (refreshTimerRef.current !== null) {
        return;
      }
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshSnapshot();
      }, delayMs);
    },
    [refreshSnapshot],
  );

  const notifyFromEvent = useCallback(
    async (event: OrchestrationEvent): Promise<void> => {
      if (!notificationsEnabled) {
        return;
      }
      const cache = notificationEventIdsRef.current;
      if (cache.has(event.eventId)) {
        return;
      }
      cache.add(event.eventId);
      trimEventCache(cache);
      const notification = notificationFromDomainEvent(event);
      if (!notification) {
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: notification.title,
          body: notification.body,
          data: {
            threadId: String(event.aggregateId),
            eventType: event.type,
          },
        },
        trigger: null,
      });
    },
    [notificationsEnabled],
  );

  const handleDomainEvent = useCallback(
    (event: OrchestrationEvent): void => {
      void notifyFromEvent(event).catch((error) => {
        setStatusMessage(`Notification delivery failed: ${formatError(error)}`);
      });
      queueRefresh(event.type === "thread.message-sent" ? 220 : 120);
    },
    [notifyFromEvent, queueRefresh],
  );

  const connectActiveHost = useCallback(async (): Promise<void> => {
    if (!activeHost) {
      setStatusMessage("Select a host before connecting.");
      return;
    }
    setStatusMessage(null);
    setConnectionStatus("connecting");
    await teardownClient();

    const client = createMobileWsClient({
      url: activeHost.wsUrl,
      authToken: activeHost.authToken,
      clientSessionId: activeHost.clientSessionId,
    });
    clientRef.current = client;

    connectionCleanupRef.current = client.onConnectionStateChange((state) => {
      if (state.kind === "connected") {
        setConnectionStatus("connected");
        return;
      }
      setConnectionStatus("disconnected");
      if (state.error) {
        setStatusMessage(`Connection interrupted: ${state.error}`);
      }
    });
    domainEventCleanupRef.current = client.orchestration.onDomainEvent(handleDomainEvent);
    terminalEventCleanupRef.current = client.terminal.onEvent(handleTerminalEvent);

    try {
      await Promise.all([refreshSnapshot(client), refreshServerConfig(client)]);
      const connectedAt = new Date().toISOString();
      const nextHosts = hosts.map((host) =>
        host.id === activeHost.id
          ? {
              ...host,
              clientSessionId: client.identity.clientSessionId,
              lastConnectedAt: connectedAt,
            }
          : host,
      );
      await persistHosts(nextHosts, activeHost.id);
      setConnectionStatus("connected");
      setStatusMessage(`Connected to ${activeHost.name}.`);
    } catch (error) {
      setConnectionStatus("disconnected");
      await teardownClient();
      setStatusMessage(`Failed to connect: ${formatError(error)}`);
    }
  }, [
    activeHost,
    handleDomainEvent,
    handleTerminalEvent,
    hosts,
    persistHosts,
    refreshServerConfig,
    refreshSnapshot,
    teardownClient,
  ]);

  const disconnect = useCallback(async (): Promise<void> => {
    await teardownClient();
    setConnectionStatus("disconnected");
    setSnapshot(null);
    setProviderCount(0);
    setEditorEntries([]);
    setEditorSelectedFilePath(null);
    setEditorContent("");
    setEditorOriginalContent("");
    setTerminalOutput("");
    setTerminalStatus("idle");
    setStatusMessage("Disconnected.");
  }, [teardownClient]);

  const refreshNow = useCallback(async (): Promise<void> => {
    await Promise.all([refreshSnapshot(), refreshServerConfig()]);
  }, [refreshServerConfig, refreshSnapshot]);

  const upsertHost = useCallback(
    async (
      draft: { name?: string; wsUrl: string; authToken?: string },
      makeActive: boolean,
    ): Promise<void> => {
      let instance: HostInstance;
      try {
        instance = createHostInstance({
          wsUrl: draft.wsUrl,
          ...(draft.name ? { name: draft.name } : {}),
          ...(draft.authToken ? { authToken: draft.authToken } : {}),
        });
      } catch (error) {
        setStatusMessage(formatError(error));
        return;
      }
      const duplicateIndex = hosts.findIndex(
        (host) => host.wsUrl === instance.wsUrl && host.authToken === instance.authToken,
      );
      const nextHosts =
        duplicateIndex === -1
          ? [...hosts, instance]
          : hosts.map((host, index) =>
              index === duplicateIndex
                ? {
                    ...host,
                    name: instance.name,
                    wsUrl: instance.wsUrl,
                    authToken: instance.authToken,
                  }
                : host,
            );
      const nextActiveHostId =
        makeActive || activeHostId === null
          ? ((duplicateIndex === -1 ? instance.id : nextHosts[duplicateIndex]?.id) ?? instance.id)
          : activeHostId;
      await persistHosts(nextHosts, nextActiveHostId);
      setHostForm(
        createInitialHostForm(nextHosts.find((host) => host.id === nextActiveHostId) ?? null),
      );
      setStatusMessage(`Saved host ${instance.name}.`);
    },
    [activeHostId, hosts, persistHosts],
  );

  const removeHost = useCallback(
    async (hostId: string): Promise<void> => {
      const target = hosts.find((host) => host.id === hostId);
      if (!target) {
        return;
      }
      const nextHosts = hosts.filter((host) => host.id !== hostId);
      const nextActiveHostId = activeHostId === hostId ? (nextHosts[0]?.id ?? null) : activeHostId;
      await persistHosts(nextHosts, nextActiveHostId);
      if (activeHostId === hostId) {
        await disconnect();
      }
      setStatusMessage(`Removed host ${target.name}.`);
    },
    [activeHostId, disconnect, hosts, persistHosts],
  );

  const applyScannedHost = useCallback(
    async (payload: string): Promise<void> => {
      const parsed = parseHostConnectionQrPayload(payload);
      if (!parsed) {
        setStatusMessage("QR code does not contain a valid ace host.");
        setScanLocked(false);
        return;
      }
      if (parsed.kind === "direct") {
        await upsertHost(parsed.draft, true);
        setScannerVisible(false);
        setScanLocked(false);
        return;
      }

      setStatusMessage("Waiting for host approval…");
      try {
        const receipt = await requestPairingClaim(parsed.pairing, {
          requesterName: "ace mobile",
          requestTimeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
        });
        const resolvedHost = await waitForPairingApproval(receipt, {
          timeoutMs: 90_000,
          pollIntervalMs: 1_200,
          requestTimeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
        });
        await upsertHost(resolvedHost, true);
        setScannerVisible(false);
        setStatusMessage("Pairing complete.");
      } catch (error) {
        setStatusMessage(`Pairing failed: ${formatError(error)}`);
      } finally {
        setScanLocked(false);
      }
    },
    [upsertHost],
  );

  const openScanner = useCallback(async (): Promise<void> => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        setStatusMessage("Camera access is required to scan host QR codes.");
        return;
      }
    }
    setScanLocked(false);
    setScannerVisible(true);
  }, [cameraPermission?.granted, requestCameraPermission]);

  const onQrScanned = useCallback(
    (event: BarcodeScanningResult): void => {
      if (scanLocked) {
        return;
      }
      setScanLocked(true);
      void applyScannedHost(event.data);
    },
    [applyScannedHost, scanLocked],
  );

  const sendPrompt = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient || !threadDetail) {
      return;
    }
    const text = promptInput.trim();
    if (text.length === 0) {
      setStatusMessage("Prompt cannot be empty.");
      return;
    }
    setWorkflowAction("sending");
    setStatusMessage(null);
    try {
      await activeClient.orchestration.dispatchCommand(
        createThreadTurnStartCommand({
          threadId: threadDetail.id,
          text,
          modelSelection: threadDetail.modelSelection,
          runtimeMode: threadDetail.runtimeMode,
          interactionMode: threadDetail.interactionMode,
        }),
      );
      setPromptInput("");
      queueRefresh(80);
    } catch (error) {
      setStatusMessage(`Failed to send prompt: ${formatError(error)}`);
    } finally {
      setWorkflowAction(null);
    }
  }, [promptInput, queueRefresh, threadDetail]);

  const interruptTurn = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient || !threadDetail) {
      return;
    }
    setWorkflowAction("interrupting");
    setStatusMessage(null);
    try {
      await activeClient.orchestration.dispatchCommand(
        createThreadTurnInterruptCommand({
          threadId: threadDetail.id,
          turnId: threadDetail.session?.activeTurnId ?? threadDetail.latestTurn?.turnId ?? null,
        }),
      );
      queueRefresh(80);
    } catch (error) {
      setStatusMessage(`Failed to interrupt turn: ${formatError(error)}`);
    } finally {
      setWorkflowAction(null);
    }
  }, [queueRefresh, threadDetail]);

  const stopSession = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient || !threadDetail) {
      return;
    }
    setWorkflowAction("stopping");
    setStatusMessage(null);
    try {
      await activeClient.orchestration.dispatchCommand(
        createThreadSessionStopCommand({ threadId: threadDetail.id }),
      );
      queueRefresh(80);
    } catch (error) {
      setStatusMessage(`Failed to stop session: ${formatError(error)}`);
    } finally {
      setWorkflowAction(null);
    }
  }, [queueRefresh, threadDetail]);

  const openEditorTree = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient) {
      setStatusMessage("Connect to a host first.");
      return;
    }
    const project = projects.find((item) => item.id === editorProjectId);
    if (!project) {
      setStatusMessage("Select a project for editor.");
      return;
    }
    setEditorLoading(true);
    try {
      const result = await activeClient.projects.listTree({ cwd: project.workspaceRoot });
      setEditorEntries(result.entries);
      setStatusMessage(
        `Loaded ${String(result.entries.length)} entries${result.truncated ? " (truncated)" : ""}.`,
      );
    } catch (error) {
      setStatusMessage(`Failed to load editor tree: ${formatError(error)}`);
    } finally {
      setEditorLoading(false);
    }
  }, [editorProjectId, projects]);

  const openEditorFile = useCallback(
    async (relativePath: string): Promise<void> => {
      const activeClient = clientRef.current;
      if (!activeClient) {
        setStatusMessage("Connect to a host first.");
        return;
      }
      const project = projects.find((item) => item.id === editorProjectId);
      if (!project) {
        setStatusMessage("Select a project for editor.");
        return;
      }
      setEditorLoading(true);
      try {
        const result = await activeClient.projects.readFile({
          cwd: project.workspaceRoot,
          relativePath,
        });
        setEditorSelectedFilePath(result.relativePath);
        setEditorContent(result.contents);
        setEditorOriginalContent(result.contents);
      } catch (error) {
        setStatusMessage(`Failed to open file: ${formatError(error)}`);
      } finally {
        setEditorLoading(false);
      }
    },
    [editorProjectId, projects],
  );

  const saveEditorFile = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient) {
      setStatusMessage("Connect to a host first.");
      return;
    }
    const project = projects.find((item) => item.id === editorProjectId);
    if (!project || !editorSelectedFilePath) {
      setStatusMessage("Select a file before saving.");
      return;
    }
    setEditorSaving(true);
    try {
      await activeClient.projects.writeFile({
        cwd: project.workspaceRoot,
        relativePath: editorSelectedFilePath,
        contents: editorContent,
      });
      setEditorOriginalContent(editorContent);
      setStatusMessage(`Saved ${editorSelectedFilePath}.`);
    } catch (error) {
      setStatusMessage(`Save failed: ${formatError(error)}`);
    } finally {
      setEditorSaving(false);
    }
  }, [editorContent, editorProjectId, editorSelectedFilePath, projects]);

  const openTerminal = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient) {
      setStatusMessage("Connect to a host first.");
      return;
    }
    const thread = allThreads.find((item) => item.id === terminalThreadId);
    if (!thread) {
      setStatusMessage("Select a thread for terminal.");
      return;
    }
    const project = projects.find((item) => item.id === thread.projectId);
    if (!project) {
      setStatusMessage("Unable to resolve project root for terminal.");
      return;
    }
    setTerminalBusy(true);
    try {
      const snapshot = await activeClient.terminal.open({
        threadId: thread.id,
        terminalId: TERMINAL_ID,
        cwd: project.workspaceRoot,
      });
      setTerminalStatus(snapshot.status);
      setTerminalTitle(snapshot.title ?? "Terminal");
      setTerminalCwd(snapshot.cwd);
      setTerminalOutput(truncateTerminalOutput(snapshot.history));
      setStatusMessage(`Terminal attached to ${thread.title}.`);
    } catch (error) {
      setStatusMessage(`Terminal open failed: ${formatError(error)}`);
    } finally {
      setTerminalBusy(false);
    }
  }, [allThreads, projects, terminalThreadId]);

  const closeTerminal = useCallback(async (): Promise<void> => {
    const activeClient = clientRef.current;
    if (!activeClient || !terminalThreadId) {
      return;
    }
    setTerminalBusy(true);
    try {
      await activeClient.terminal.close({
        threadId: terminalThreadId,
        terminalId: TERMINAL_ID,
        deleteHistory: false,
      });
      setTerminalStatus("idle");
      setStatusMessage("Terminal closed.");
    } catch (error) {
      setStatusMessage(`Terminal close failed: ${formatError(error)}`);
    } finally {
      setTerminalBusy(false);
    }
  }, [terminalThreadId]);

  const writeTerminalData = useCallback(
    async (data: string): Promise<void> => {
      const activeClient = clientRef.current;
      if (!activeClient || !terminalThreadId) {
        setStatusMessage("Select a terminal thread and connect first.");
        return;
      }
      try {
        await activeClient.terminal.write({
          threadId: terminalThreadId,
          terminalId: TERMINAL_ID,
          data,
        });
      } catch (error) {
        setStatusMessage(`Terminal write failed: ${formatError(error)}`);
      }
    },
    [terminalThreadId],
  );

  const sendTerminalCommand = useCallback(async (): Promise<void> => {
    const command = terminalInput.trim();
    if (command.length === 0) {
      return;
    }
    await writeTerminalData(`${command}\n`);
    setTerminalHistory((previous) => uniquePush(previous, command, 80));
    setTerminalInput("");
  }, [terminalInput, writeTerminalData]);

  const openBrowserAddress = useCallback((): void => {
    try {
      const normalized = normalizeBrowserAddress(browserAddressInput);
      setBrowserCurrentUrl(normalized);
      setBrowserAddressInput(normalized);
    } catch (error) {
      setStatusMessage(`Browser URL invalid: ${formatError(error)}`);
    }
  }, [browserAddressInput]);

  useEffect(() => {
    let mounted = true;
    void Notifications.getPermissionsAsync()
      .then((permissions) => {
        if (!mounted) {
          return;
        }
        if (permissions.granted) {
          setNotificationsEnabled(true);
          return;
        }
        return Notifications.requestPermissionsAsync().then((requested) => {
          if (mounted) {
            setNotificationsEnabled(requested.granted);
          }
        });
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        setStatusMessage(`Notification permission failed: ${formatError(error)}`);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      AsyncStorage.getItem(HOSTS_STORAGE_KEY),
      AsyncStorage.getItem(ACTIVE_HOST_STORAGE_KEY),
    ])
      .then(([rawHosts, rawActiveHostId]) => {
        if (!mounted) {
          return;
        }
        let parsedHosts: HostInstance[] = [];
        if (rawHosts) {
          try {
            const decoded = JSON.parse(rawHosts) as unknown;
            if (Array.isArray(decoded)) {
              parsedHosts = sortedCopy(
                decoded.flatMap((item) => {
                  if (!item || typeof item !== "object") {
                    return [];
                  }
                  const candidate = item as Partial<HostInstance>;
                  if (typeof candidate.wsUrl !== "string") {
                    return [];
                  }
                  try {
                    const normalized = createHostInstance(
                      {
                        wsUrl: candidate.wsUrl,
                        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
                        ...(typeof candidate.authToken === "string"
                          ? { authToken: candidate.authToken }
                          : {}),
                      },
                      typeof candidate.id === "string"
                        ? {
                            id: candidate.id,
                            name:
                              typeof candidate.name === "string"
                                ? candidate.name
                                : `ace @ ${candidate.wsUrl}`,
                            wsUrl: candidate.wsUrl,
                            authToken:
                              typeof candidate.authToken === "string" ? candidate.authToken : "",
                            clientSessionId:
                              typeof candidate.clientSessionId === "string"
                                ? candidate.clientSessionId
                                : randomUUID(),
                            createdAt:
                              typeof candidate.createdAt === "string"
                                ? candidate.createdAt
                                : new Date().toISOString(),
                            ...(typeof candidate.lastConnectedAt === "string"
                              ? { lastConnectedAt: candidate.lastConnectedAt }
                              : {}),
                          }
                        : undefined,
                    );
                    return [normalized];
                  } catch {
                    return [];
                  }
                }),
                (left, right) => left.createdAt.localeCompare(right.createdAt),
              );
            }
          } catch {
            parsedHosts = [];
          }
        }
        const activeId = parsedHosts.some((host) => host.id === rawActiveHostId)
          ? rawActiveHostId
          : (parsedHosts[0]?.id ?? null);
        setHosts(parsedHosts);
        setActiveHostId(activeId);
        const initialHost = parsedHosts.find((host) => host.id === activeId) ?? null;
        setHostForm(createInitialHostForm(initialHost));
        const browserBase = initialHost ? wsUrlToBrowserBaseUrl(initialHost.wsUrl) : "";
        setBrowserAddressInput(browserBase);
        setBrowserCurrentUrl(browserBase);
        setHostsLoaded(true);
      })
      .catch((error: unknown) => {
        if (!mounted) {
          return;
        }
        setHosts([]);
        setActiveHostId(null);
        setHostForm(createInitialHostForm(null));
        setBrowserAddressInput("");
        setBrowserCurrentUrl("");
        setHostsLoaded(true);
        setStatusMessage(`Failed to load hosts: ${formatError(error)}`);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId(null);
      setEditorProjectId(null);
      return;
    }
    if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? null);
    }
    if (!editorProjectId || !projects.some((project) => project.id === editorProjectId)) {
      setEditorProjectId(projects[0]?.id ?? null);
    }
  }, [editorProjectId, projects, selectedProjectId]);

  useEffect(() => {
    if (allThreads.length === 0) {
      setThreadDetailThreadId(null);
      setTerminalThreadId(null);
      return;
    }
    if (!terminalThreadId || !allThreads.some((thread) => thread.id === terminalThreadId)) {
      setTerminalThreadId(allThreads[0]?.id ?? null);
    }
    if (
      threadDetailThreadId !== null &&
      !allThreads.some((thread) => thread.id === threadDetailThreadId)
    ) {
      setThreadDetailThreadId(null);
    }
  }, [allThreads, terminalThreadId, threadDetailThreadId]);

  useEffect(() => {
    if (!activeHost) {
      return;
    }
    setHostForm(createInitialHostForm(activeHost));
    const browserBase = wsUrlToBrowserBaseUrl(activeHost.wsUrl);
    setBrowserAddressInput(browserBase);
    setBrowserCurrentUrl(browserBase);
  }, [activeHost]);

  const connected = connectionStatus === "connected";
  const busy = workflowAction !== null;

  const renderConnectionSection = () => (
    <View style={styles.card}>
      <View style={styles.connectionHeader}>
        <Text style={styles.sectionTitle}>Hosts</Text>
        <View
          style={[
            styles.statusPill,
            connectionStatus === "connected"
              ? styles.statusConnected
              : connectionStatus === "connecting"
                ? styles.statusConnecting
                : styles.statusDisconnected,
          ]}
        >
          <Text style={styles.statusPillText}>
            {connectionStatus === "connected"
              ? "Connected"
              : connectionStatus === "connecting"
                ? "Connecting"
                : "Disconnected"}
          </Text>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.hostChipRow}>
          {hosts.length === 0 ? (
            <Text style={styles.emptyText}>
              No hosts configured yet. Scan a pairing QR or save a host URL below.
            </Text>
          ) : (
            hosts.map((host) => (
              <Pressable
                key={host.id}
                onPress={() => {
                  if (host.id === activeHostId) {
                    return;
                  }
                  setActiveHostId(host.id);
                }}
                style={({ pressed }) => [
                  styles.hostChip,
                  host.id === activeHostId ? styles.hostChipActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.hostChipTitle}>{host.name}</Text>
                <Text style={styles.hostChipMeta}>{host.wsUrl}</Text>
                <Text style={styles.hostChipMeta}>
                  last: {host.lastConnectedAt ? formatRelativeDate(host.lastConnectedAt) : "never"}
                </Text>
                <Pressable
                  onPress={() => {
                    void removeHost(host.id);
                  }}
                  style={({ pressed }) => [
                    styles.removeHostButton,
                    pressed ? styles.buttonPressed : undefined,
                  ]}
                >
                  <Text style={styles.removeHostButtonText}>Remove</Text>
                </Pressable>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>

      <View style={styles.buttonRow}>
        <Pressable
          onPress={() => {
            void connectActiveHost();
          }}
          style={({ pressed }) => [
            styles.buttonPrimary,
            pressed ? styles.buttonPressed : undefined,
            !hostsLoaded || hosts.length === 0 || !activeHost ? styles.buttonDisabled : undefined,
          ]}
          disabled={!hostsLoaded || hosts.length === 0 || !activeHost}
        >
          <Text style={styles.buttonPrimaryText}>
            {connectionStatus === "connected" ? "Reconnect" : "Connect"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void disconnect();
          }}
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed ? styles.buttonPressed : undefined,
            !connected ? styles.buttonDisabled : undefined,
          ]}
          disabled={!connected}
        >
          <Text style={styles.buttonSecondaryText}>Disconnect</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void refreshNow();
          }}
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed ? styles.buttonPressed : undefined,
            !connected ? styles.buttonDisabled : undefined,
          ]}
          disabled={!connected}
        >
          <Text style={styles.buttonSecondaryText}>Refresh</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Host name</Text>
      <TextInput
        value={hostForm.name}
        onChangeText={(value) =>
          setHostForm((previous) => ({
            ...previous,
            name: value,
          }))
        }
        style={styles.input}
        placeholder="My desktop ace"
        placeholderTextColor={MOBILE_THEME.mutedForeground}
      />

      <Text style={styles.label}>WebSocket URL</Text>
      <TextInput
        value={hostForm.wsUrl}
        onChangeText={(value) =>
          setHostForm((previous) => ({
            ...previous,
            wsUrl: value,
          }))
        }
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="ws://192.168.x.x:3773/ws"
        placeholderTextColor={MOBILE_THEME.mutedForeground}
      />

      <Text style={styles.label}>Auth token (optional)</Text>
      <TextInput
        value={hostForm.authToken}
        onChangeText={(value) =>
          setHostForm((previous) => ({
            ...previous,
            authToken: value,
          }))
        }
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="ACE_AUTH_TOKEN"
        placeholderTextColor={MOBILE_THEME.mutedForeground}
      />

      <View style={styles.buttonRow}>
        <Pressable
          onPress={() => {
            void upsertHost(
              {
                name: hostForm.name,
                wsUrl: hostForm.wsUrl,
                authToken: hostForm.authToken,
              },
              true,
            );
          }}
          style={({ pressed }) => [
            styles.buttonPrimary,
            pressed ? styles.buttonPressed : undefined,
          ]}
        >
          <Text style={styles.buttonPrimaryText}>Save host</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void openScanner();
          }}
          style={({ pressed }) => [
            styles.buttonSecondary,
            pressed ? styles.buttonPressed : undefined,
          ]}
        >
          <Text style={styles.buttonSecondaryText}>Scan QR</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderProjectsTab = () => (
    <ScrollView contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <Text style={styles.title}>ace Mobile</Text>
        <Text style={styles.subtitle}>Project dashboard + host control</Text>
      </View>

      {renderConnectionSection()}

      <View style={styles.metricsRow}>
        <View style={styles.metricCard}>
          <Text style={styles.metricLabel}>Projects</Text>
          <Text style={styles.metricValue}>{projects.length}</Text>
        </View>
        <View style={styles.metricCard}>
          <Text style={styles.metricLabel}>Threads</Text>
          <Text style={styles.metricValue}>{allThreads.length}</Text>
        </View>
        <View style={styles.metricCard}>
          <Text style={styles.metricLabel}>Providers</Text>
          <Text style={styles.metricValue}>{providerCount}</Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Current projects</Text>
        {projects.length === 0 ? (
          <Text style={styles.emptyText}>No projects loaded yet.</Text>
        ) : (
          <View style={styles.projectList}>
            {projects.map((project) => {
              const stats = resolveProjectAgentStats(allThreads, project.id);
              return (
                <View key={project.id} style={styles.projectCard}>
                  <View style={styles.projectCardHeader}>
                    <Text style={styles.projectTitle}>{project.title}</Text>
                    <Text style={styles.projectRoot}>{project.workspaceRoot}</Text>
                  </View>
                  <View style={styles.projectStatsRow}>
                    <View style={styles.projectStatBadge}>
                      <Text style={styles.projectStatLabel}>Working</Text>
                      <Text style={styles.projectStatValue}>{stats.working}</Text>
                    </View>
                    <View style={styles.projectStatBadge}>
                      <Text style={styles.projectStatLabel}>Completed</Text>
                      <Text style={styles.projectStatValue}>{stats.completed}</Text>
                    </View>
                    <View style={styles.projectStatBadge}>
                      <Text style={styles.projectStatLabel}>Pending</Text>
                      <Text style={styles.projectStatValue}>{stats.pending}</Text>
                    </View>
                  </View>
                  <View style={styles.buttonRow}>
                    <Pressable
                      onPress={() => {
                        setSelectedProjectId(project.id);
                        setActiveTab("threads");
                      }}
                      style={({ pressed }) => [
                        styles.buttonSecondary,
                        pressed ? styles.buttonPressed : undefined,
                      ]}
                    >
                      <Text style={styles.buttonSecondaryText}>Open Threads</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setEditorProjectId(project.id);
                        setActiveTab("editor");
                      }}
                      style={({ pressed }) => [
                        styles.buttonSecondary,
                        pressed ? styles.buttonPressed : undefined,
                      ]}
                    >
                      <Text style={styles.buttonSecondaryText}>Open Editor</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>
      <View style={styles.footerPad} />
    </ScrollView>
  );

  const renderThreadsTab = () => (
    <ScrollView contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>Threads</Text>
          <Text style={styles.sectionMeta}>{filteredThreads.length} shown</Text>
        </View>

        {projects.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.pillList}>
              {projects.map((project) => (
                <Pressable
                  key={project.id}
                  onPress={() => setSelectedProjectId(project.id)}
                  style={({ pressed }) => [
                    styles.projectPill,
                    project.id === selectedProjectId ? styles.projectPillActive : undefined,
                    pressed ? styles.buttonPressed : undefined,
                  ]}
                >
                  <Text style={styles.projectPillTitle}>{project.title}</Text>
                  <Text style={styles.projectPillSubtitle}>{project.workspaceRoot}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => setSelectedProjectId(null)}
                style={({ pressed }) => [
                  styles.projectPill,
                  selectedProjectId === null ? styles.projectPillActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.projectPillTitle}>All projects</Text>
                <Text style={styles.projectPillSubtitle}>Merged thread view</Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : (
          <Text style={styles.emptyText}>No projects available.</Text>
        )}

        {filteredThreads.length === 0 ? (
          <Text style={styles.emptyText}>No threads for this project yet.</Text>
        ) : (
          <View style={styles.threadList}>
            {filteredThreads.map((thread) => (
              <Pressable
                key={thread.id}
                onPress={() => {
                  setThreadDetailThreadId(thread.id);
                }}
                style={({ pressed }) => [
                  styles.threadCard,
                  thread.id === threadDetailThreadId ? styles.threadCardActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <View style={styles.threadHeaderRow}>
                  <Text style={styles.threadTitle}>{thread.title}</Text>
                  <Text style={styles.threadStatus}>{thread.session?.status ?? "idle"}</Text>
                </View>
                <Text style={styles.threadMeta}>
                  {thread.modelSelection.provider} / {thread.modelSelection.model}
                </Text>
                <Text style={styles.threadPreview}>{summarizeThread(thread)}</Text>
                <Text style={styles.threadMeta}>
                  updated {formatRelativeDate(thread.updatedAt)} • {thread.messages.length} messages
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {threadDetail ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Thread detail</Text>
          <Text style={styles.threadTitle}>{threadDetail.title}</Text>
          <Text style={styles.threadMeta}>
            Runtime: {threadDetail.runtimeMode} • Interaction: {threadDetail.interactionMode}
          </Text>
          <Text style={styles.threadMeta}>
            Session: {threadDetail.session?.status ?? "idle"} • Active turn:{" "}
            {threadDetail.session?.activeTurnId ?? "none"}
          </Text>

          <TextInput
            value={promptInput}
            onChangeText={setPromptInput}
            style={[styles.input, styles.promptInput]}
            placeholder="Send prompt..."
            placeholderTextColor={MOBILE_THEME.mutedForeground}
            multiline
          />
          <View style={styles.buttonRow}>
            <Pressable
              onPress={() => {
                void sendPrompt();
              }}
              style={({ pressed }) => [
                styles.buttonPrimary,
                pressed ? styles.buttonPressed : undefined,
                busy ? styles.buttonDisabled : undefined,
              ]}
              disabled={busy || !connected}
            >
              <Text style={styles.buttonPrimaryText}>
                {workflowAction === "sending" ? "Sending..." : "Send"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void interruptTurn();
              }}
              style={({ pressed }) => [
                styles.buttonSecondary,
                pressed ? styles.buttonPressed : undefined,
                busy ? styles.buttonDisabled : undefined,
              ]}
              disabled={busy || !connected}
            >
              <Text style={styles.buttonSecondaryText}>
                {workflowAction === "interrupting" ? "Interrupting..." : "Interrupt"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                void stopSession();
              }}
              style={({ pressed }) => [
                styles.buttonSecondary,
                pressed ? styles.buttonPressed : undefined,
                busy ? styles.buttonDisabled : undefined,
              ]}
              disabled={busy || !connected}
            >
              <Text style={styles.buttonSecondaryText}>
                {workflowAction === "stopping" ? "Stopping..." : "Stop"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setTerminalThreadId(threadDetail.id);
                setActiveTab("terminal");
              }}
              style={({ pressed }) => [
                styles.buttonSecondary,
                pressed ? styles.buttonPressed : undefined,
              ]}
            >
              <Text style={styles.buttonSecondaryText}>Terminal</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionSubheading}>Messages</Text>
          {visibleMessages.length === 0 ? (
            <Text style={styles.emptyText}>No messages yet.</Text>
          ) : (
            <View style={styles.messageList}>
              {visibleMessages.map((message) => (
                <View
                  key={message.id}
                  style={[
                    styles.messageBubble,
                    message.role === "assistant"
                      ? styles.messageAssistant
                      : message.role === "user"
                        ? styles.messageUser
                        : styles.messageSystem,
                  ]}
                >
                  <View style={styles.messageMetaRow}>
                    <Text style={styles.messageRole}>{message.role}</Text>
                    <Text style={styles.messageTime}>{formatRelativeDate(message.createdAt)}</Text>
                  </View>
                  <Text style={styles.messageBody}>
                    {message.text.trim().length > 0 ? message.text : "(empty message)"}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionSubheading}>Activity</Text>
          {visibleActivities.length === 0 ? (
            <Text style={styles.emptyText}>No activity yet.</Text>
          ) : (
            <View style={styles.activityList}>
              {visibleActivities.map((activity) => (
                <View key={activity.id} style={styles.activityRow}>
                  <View style={styles.activityBadge}>
                    <Text style={styles.activityBadgeText}>{activity.tone}</Text>
                  </View>
                  <View style={styles.activityBody}>
                    <Text style={styles.activitySummary}>{activity.summary}</Text>
                    <Text style={styles.activityMeta}>
                      {activity.kind} • {formatRelativeDate(activity.createdAt)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.emptyText}>Tap a thread to open chat controls.</Text>
        </View>
      )}
      <View style={styles.footerPad} />
    </ScrollView>
  );

  const renderBrowserTab = () => (
    <View style={styles.fullTabContainer}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Browser</Text>
        <Text style={styles.label}>Address</Text>
        <TextInput
          value={browserAddressInput}
          onChangeText={setBrowserAddressInput}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://your-ace-host:3773/"
          placeholderTextColor={MOBILE_THEME.mutedForeground}
        />
        <View style={styles.buttonRow}>
          <Pressable
            onPress={openBrowserAddress}
            style={({ pressed }) => [
              styles.buttonPrimary,
              pressed ? styles.buttonPressed : undefined,
            ]}
          >
            <Text style={styles.buttonPrimaryText}>Open</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (!activeHost) {
                return;
              }
              const base = wsUrlToBrowserBaseUrl(activeHost.wsUrl);
              setBrowserAddressInput(base);
              setBrowserCurrentUrl(base);
            }}
            style={({ pressed }) => [
              styles.buttonSecondary,
              pressed ? styles.buttonPressed : undefined,
            ]}
            disabled={!activeHost}
          >
            <Text style={styles.buttonSecondaryText}>Host home</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.browserContainer}>
        {browserCurrentUrl.length > 0 ? (
          <WebView
            source={{ uri: browserCurrentUrl }}
            style={styles.webview}
            startInLoadingState
            onError={(event: WebViewErrorEvent) => {
              setStatusMessage(`Browser failed: ${event.nativeEvent.description}`);
            }}
          />
        ) : (
          <View style={styles.browserPlaceholder}>
            <Text style={styles.emptyText}>Enter a URL to open the browser.</Text>
          </View>
        )}
      </View>
    </View>
  );

  const renderEditorTab = () => (
    <ScrollView contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Editor</Text>
        <Text style={styles.label}>Project</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.pillList}>
            {projects.map((project) => (
              <Pressable
                key={project.id}
                onPress={() => {
                  setEditorProjectId(project.id);
                  setEditorEntries([]);
                  setEditorSelectedFilePath(null);
                  setEditorContent("");
                  setEditorOriginalContent("");
                }}
                style={({ pressed }) => [
                  styles.projectPill,
                  project.id === editorProjectId ? styles.projectPillActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.projectPillTitle}>{project.title}</Text>
                <Text style={styles.projectPillSubtitle}>{project.workspaceRoot}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={styles.buttonRow}>
          <Pressable
            onPress={() => {
              void openEditorTree();
            }}
            style={({ pressed }) => [
              styles.buttonPrimary,
              pressed ? styles.buttonPressed : undefined,
              editorLoading ? styles.buttonDisabled : undefined,
            ]}
            disabled={editorLoading || !connected}
          >
            <Text style={styles.buttonPrimaryText}>
              {editorLoading ? "Loading..." : "Load files"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void saveEditorFile();
            }}
            style={({ pressed }) => [
              styles.buttonSecondary,
              pressed ? styles.buttonPressed : undefined,
              editorSaving || !editorHasUnsavedChanges ? styles.buttonDisabled : undefined,
            ]}
            disabled={editorSaving || !editorHasUnsavedChanges || !connected}
          >
            <Text style={styles.buttonSecondaryText}>
              {editorSaving ? "Saving..." : "Save file"}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.sectionSubheading}>Files</Text>
        {editorFiles.length === 0 ? (
          <Text style={styles.emptyText}>Load files to start editing.</Text>
        ) : (
          <View style={styles.fileList}>
            {editorFiles.slice(0, 120).map((entry) => (
              <Pressable
                key={entry.path}
                onPress={() => {
                  void openEditorFile(entry.path);
                }}
                style={({ pressed }) => [
                  styles.fileItem,
                  editorSelectedFilePath === entry.path ? styles.fileItemActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.fileItemPath}>{entry.path}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={styles.sectionSubheading}>
          {editorSelectedFilePath ?? "Select a file to edit"}
        </Text>
        <TextInput
          value={editorContent}
          onChangeText={setEditorContent}
          style={[styles.input, styles.editorInput]}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          editable={editorSelectedFilePath !== null}
          placeholder="File contents"
          placeholderTextColor={MOBILE_THEME.mutedForeground}
        />
      </View>
      <View style={styles.footerPad} />
    </ScrollView>
  );

  const renderTerminalTab = () => (
    <ScrollView contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Terminal</Text>
        <Text style={styles.threadMeta}>
          {terminalTitle} • {terminalStatus}
          {terminalCwd ? ` • ${terminalCwd}` : ""}
        </Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.pillList}>
            {allThreads.map((thread) => (
              <Pressable
                key={thread.id}
                onPress={() => setTerminalThreadId(thread.id)}
                style={({ pressed }) => [
                  styles.projectPill,
                  thread.id === terminalThreadId ? styles.projectPillActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.projectPillTitle}>{thread.title}</Text>
                <Text style={styles.projectPillSubtitle}>{thread.modelSelection.provider}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={styles.buttonRow}>
          <Pressable
            onPress={() => {
              void openTerminal();
            }}
            style={({ pressed }) => [
              styles.buttonPrimary,
              pressed ? styles.buttonPressed : undefined,
              terminalBusy || !connected ? styles.buttonDisabled : undefined,
            ]}
            disabled={terminalBusy || !connected}
          >
            <Text style={styles.buttonPrimaryText}>Open</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void closeTerminal();
            }}
            style={({ pressed }) => [
              styles.buttonSecondary,
              pressed ? styles.buttonPressed : undefined,
              terminalBusy || !connected ? styles.buttonDisabled : undefined,
            ]}
            disabled={terminalBusy || !connected}
          >
            <Text style={styles.buttonSecondaryText}>Close</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setTerminalOutput("");
            }}
            style={({ pressed }) => [
              styles.buttonSecondary,
              pressed ? styles.buttonPressed : undefined,
            ]}
          >
            <Text style={styles.buttonSecondaryText}>Clear View</Text>
          </Pressable>
        </View>

        <View style={styles.terminalOutputBox}>
          <ScrollView style={styles.terminalScroll}>
            <Text style={styles.terminalOutputText}>
              {terminalOutput.length > 0 ? terminalOutput : "Terminal output appears here..."}
            </Text>
          </ScrollView>
        </View>

        <View style={styles.terminalInputRow}>
          <TextInput
            value={terminalInput}
            onChangeText={setTerminalInput}
            style={[styles.input, styles.terminalInput]}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Type a command..."
            placeholderTextColor={MOBILE_THEME.mutedForeground}
            onSubmitEditing={() => {
              void sendTerminalCommand();
            }}
          />
          <Pressable
            onPress={() => {
              void sendTerminalCommand();
            }}
            style={({ pressed }) => [
              styles.buttonPrimary,
              pressed ? styles.buttonPressed : undefined,
              !connected ? styles.buttonDisabled : undefined,
            ]}
            disabled={!connected}
          >
            <Text style={styles.buttonPrimaryText}>Run</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.quickKeysRow}>
            {(
              [
                ["Ctrl+C", "ctrl-c"],
                ["Esc", "esc"],
                ["Tab", "tab"],
                ["↑", "up"],
                ["↓", "down"],
                ["←", "left"],
                ["→", "right"],
              ] as const
            ).map(([label, key]) => (
              <Pressable
                key={label}
                onPress={() => {
                  void writeTerminalData(quickTerminalKeySequence(key));
                }}
                style={({ pressed }) => [
                  styles.quickKeyButton,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.quickKeyButtonText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.sectionSubheading}>Suggestions</Text>
        {terminalSuggestions.length === 0 ? (
          <Text style={styles.emptyText}>No command suggestions yet.</Text>
        ) : (
          <View style={styles.suggestionList}>
            {terminalSuggestions.map((suggestion) => (
              <Pressable
                key={suggestion}
                onPress={() => setTerminalInput(suggestion)}
                style={({ pressed }) => [
                  styles.suggestionItem,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.suggestionText}>{suggestion}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      <View style={styles.footerPad} />
    </ScrollView>
  );

  useEffect(() => {
    if (!hostsLoaded) {
      return;
    }
    void Promise.all([
      AsyncStorage.setItem(HOSTS_STORAGE_KEY, JSON.stringify(hosts)),
      AsyncStorage.setItem(ACTIVE_HOST_STORAGE_KEY, activeHostId ?? ""),
    ]).catch((error: unknown) => {
      setStatusMessage(`Failed to persist host state: ${formatError(error)}`);
    });
  }, [activeHostId, hosts, hostsLoaded]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle="light-content" />
        {statusMessage ? (
          <View style={styles.statusBanner}>
            <Text style={styles.statusBannerText}>{statusMessage}</Text>
          </View>
        ) : null}

        <View style={styles.mainPane}>
          {activeTab === "projects" ? renderProjectsTab() : null}
          {activeTab === "threads" ? renderThreadsTab() : null}
          {activeTab === "browser" ? renderBrowserTab() : null}
          {activeTab === "editor" ? renderEditorTab() : null}
          {activeTab === "terminal" ? renderTerminalTab() : null}
        </View>

        <View style={styles.bottomNav}>
          {TAB_ORDER.map((tab) => {
            const Icon = TAB_ICON[tab];
            const active = tab === activeTab;
            return (
              <Pressable
                key={tab}
                onPress={() => setActiveTab(tab)}
                style={({ pressed }) => [
                  styles.bottomNavItem,
                  active ? styles.bottomNavItemActive : undefined,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <View style={styles.bottomNavItemInner}>
                  <Icon
                    size={16}
                    color={active ? MOBILE_THEME.primary : MOBILE_THEME.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.bottomNavItemText,
                      active ? styles.bottomNavItemTextActive : undefined,
                    ]}
                  >
                    {TAB_LABEL[tab]}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <Modal
          visible={scannerVisible}
          transparent={false}
          animationType="slide"
          onRequestClose={() => {
            setScannerVisible(false);
            setScanLocked(false);
          }}
        >
          <SafeAreaView style={styles.scannerScreen}>
            <View style={styles.scannerHeader}>
              <Text style={styles.sectionTitle}>Scan ace host QR</Text>
              <Pressable
                onPress={() => {
                  setScannerVisible(false);
                  setScanLocked(false);
                }}
                style={({ pressed }) => [
                  styles.buttonSecondary,
                  pressed ? styles.buttonPressed : undefined,
                ]}
              >
                <Text style={styles.buttonSecondaryText}>Close</Text>
              </Pressable>
            </View>
            <View style={styles.scannerCameraWrapper}>
              <CameraView
                style={styles.scannerCamera}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={onQrScanned}
              />
            </View>
            <Text style={styles.connectionHint}>
              Accepted payloads: ws/wss URL, http/https URL, host:port, ace:// URL, or JSON with
              wsUrl.
            </Text>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: MOBILE_THEME.background,
  },
  mainPane: {
    flex: 1,
  },
  statusBanner: {
    backgroundColor: MOBILE_THEME.dangerSurface,
    borderBottomColor: MOBILE_THEME.dangerBorder,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusBannerText: {
    color: MOBILE_THEME.dangerForeground,
    fontSize: 12,
  },
  tabContent: {
    padding: 16,
    gap: 14,
    paddingBottom: 20,
  },
  fullTabContainer: {
    flex: 1,
    padding: 16,
    gap: 12,
  },
  header: {
    gap: 4,
    marginTop: 4,
  },
  title: {
    color: MOBILE_THEME.foreground,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  subtitle: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 14,
  },
  card: {
    backgroundColor: MOBILE_THEME.surface,
    borderColor: MOBILE_THEME.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 10,
  },
  sectionTitle: {
    color: MOBILE_THEME.foreground,
    fontSize: 17,
    fontWeight: "600",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  sectionMeta: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 12,
  },
  sectionSubheading: {
    color: MOBILE_THEME.subtleForeground,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 6,
  },
  connectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  statusConnected: {
    borderColor: "#16a34a",
    backgroundColor: "#052e16",
  },
  statusConnecting: {
    borderColor: "#d97706",
    backgroundColor: "#3d2200",
  },
  statusDisconnected: {
    borderColor: "#b91c1c",
    backgroundColor: "#3f1010",
  },
  statusPillText: {
    color: MOBILE_THEME.foreground,
    fontSize: 12,
    fontWeight: "600",
  },
  hostChipRow: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 2,
    paddingRight: 4,
  },
  hostChip: {
    minWidth: 220,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  hostChipActive: {
    borderColor: MOBILE_THEME.primary,
    backgroundColor: MOBILE_THEME.activeSurface,
  },
  hostChipTitle: {
    color: MOBILE_THEME.foreground,
    fontSize: 13,
    fontWeight: "600",
  },
  hostChipMeta: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  removeHostButton: {
    alignSelf: "flex-start",
    marginTop: 4,
    backgroundColor: MOBILE_THEME.dangerSurface,
    borderColor: MOBILE_THEME.dangerBorder,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  removeHostButtonText: {
    color: MOBILE_THEME.dangerForeground,
    fontSize: 11,
  },
  label: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    backgroundColor: MOBILE_THEME.inputSurface,
    borderColor: MOBILE_THEME.border,
    borderWidth: 1,
    borderRadius: 12,
    color: MOBILE_THEME.foreground,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  promptInput: {
    minHeight: 92,
    textAlignVertical: "top",
  },
  editorInput: {
    minHeight: 220,
    textAlignVertical: "top",
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  buttonPrimary: {
    backgroundColor: MOBILE_THEME.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 110,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimaryText: {
    color: MOBILE_THEME.primaryForeground,
    fontWeight: "700",
    fontSize: 13,
  },
  buttonSecondary: {
    backgroundColor: MOBILE_THEME.surfaceElevated,
    borderColor: MOBILE_THEME.borderStrong,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    minWidth: 110,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonSecondaryText: {
    color: MOBILE_THEME.foreground,
    fontWeight: "600",
    fontSize: 13,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 8,
  },
  metricCard: {
    flex: 1,
    backgroundColor: MOBILE_THEME.surface,
    borderRadius: 12,
    borderColor: MOBILE_THEME.border,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
  },
  metricLabel: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 12,
  },
  metricValue: {
    color: MOBILE_THEME.foreground,
    fontSize: 20,
    fontWeight: "700",
  },
  emptyText: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 13,
  },
  projectList: {
    gap: 10,
  },
  projectCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surface,
    padding: 10,
    gap: 8,
  },
  projectCardHeader: {
    gap: 2,
  },
  projectTitle: {
    color: MOBILE_THEME.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  projectRoot: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  projectStatsRow: {
    flexDirection: "row",
    gap: 8,
  },
  projectStatBadge: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: MOBILE_THEME.borderStrong,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 9,
    paddingVertical: 8,
    gap: 1,
  },
  projectStatLabel: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  projectStatValue: {
    color: MOBILE_THEME.foreground,
    fontSize: 17,
    fontWeight: "700",
  },
  pillList: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 2,
    paddingRight: 4,
  },
  projectPill: {
    minWidth: 190,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  projectPillActive: {
    borderColor: MOBILE_THEME.primary,
    backgroundColor: MOBILE_THEME.activeSurface,
  },
  projectPillTitle: {
    color: MOBILE_THEME.foreground,
    fontSize: 14,
    fontWeight: "600",
  },
  projectPillSubtitle: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  threadList: {
    gap: 9,
  },
  threadCard: {
    borderColor: MOBILE_THEME.border,
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: MOBILE_THEME.surface,
    padding: 11,
    gap: 4,
  },
  threadCardActive: {
    borderColor: MOBILE_THEME.primary,
    backgroundColor: MOBILE_THEME.activeSurface,
  },
  threadHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  threadTitle: {
    color: MOBILE_THEME.foreground,
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  threadStatus: {
    color: MOBILE_THEME.subtleForeground,
    fontSize: 11,
    textTransform: "uppercase",
  },
  threadMeta: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 12,
  },
  threadPreview: {
    color: MOBILE_THEME.subtleForeground,
    fontSize: 13,
    lineHeight: 18,
  },
  messageList: {
    gap: 8,
  },
  messageBubble: {
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: 1,
    gap: 4,
  },
  messageAssistant: {
    backgroundColor: MOBILE_THEME.surfaceElevated,
    borderColor: MOBILE_THEME.borderStrong,
  },
  messageUser: {
    backgroundColor: MOBILE_THEME.activeSurface,
    borderColor: MOBILE_THEME.primary,
  },
  messageSystem: {
    backgroundColor: MOBILE_THEME.dangerSurface,
    borderColor: MOBILE_THEME.dangerBorder,
  },
  messageMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  messageRole: {
    color: MOBILE_THEME.subtleForeground,
    fontSize: 11,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  messageTime: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  messageBody: {
    color: MOBILE_THEME.foreground,
    fontSize: 13,
    lineHeight: 18,
  },
  activityList: {
    gap: 8,
  },
  activityRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
  },
  activityBadge: {
    borderRadius: 8,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minWidth: 56,
    alignItems: "center",
  },
  activityBadgeText: {
    color: MOBILE_THEME.subtleForeground,
    fontSize: 11,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  activityBody: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surface,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 3,
  },
  activitySummary: {
    color: MOBILE_THEME.foreground,
    fontSize: 13,
    lineHeight: 18,
  },
  activityMeta: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
  },
  browserContainer: {
    flex: 1,
    borderRadius: 16,
    borderColor: MOBILE_THEME.border,
    borderWidth: 1,
    overflow: "hidden",
    backgroundColor: MOBILE_THEME.surface,
  },
  webview: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  browserPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  fileList: {
    gap: 6,
  },
  fileItem: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  fileItemActive: {
    borderColor: MOBILE_THEME.primary,
    backgroundColor: MOBILE_THEME.activeSurface,
  },
  fileItemPath: {
    color: MOBILE_THEME.foreground,
    fontSize: 12,
  },
  terminalOutputBox: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.terminalSurface,
    minHeight: 220,
    maxHeight: 320,
    overflow: "hidden",
  },
  terminalScroll: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  terminalOutputText: {
    color: MOBILE_THEME.terminalForeground,
    fontSize: 12,
    fontFamily: "Courier",
    lineHeight: 16,
  },
  terminalInputRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  terminalInput: {
    flex: 1,
  },
  quickKeysRow: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 2,
    paddingRight: 4,
  },
  quickKeyButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: MOBILE_THEME.borderStrong,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  quickKeyButtonText: {
    color: MOBILE_THEME.foreground,
    fontSize: 12,
    fontWeight: "600",
  },
  suggestionList: {
    gap: 6,
  },
  suggestionItem: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.surfaceElevated,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  suggestionText: {
    color: MOBILE_THEME.foreground,
    fontSize: 12,
  },
  bottomNav: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: MOBILE_THEME.border,
    backgroundColor: MOBILE_THEME.background,
    paddingHorizontal: 8,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 8,
  },
  bottomNavItem: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    backgroundColor: "#0f131a",
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomNavItemActive: {
    borderColor: MOBILE_THEME.primary,
    backgroundColor: MOBILE_THEME.activeSurface,
  },
  bottomNavItemInner: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  bottomNavItemText: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  bottomNavItemTextActive: {
    color: MOBILE_THEME.primary,
  },
  scannerScreen: {
    flex: 1,
    backgroundColor: MOBILE_THEME.background,
    padding: 16,
    gap: 12,
  },
  scannerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  scannerCameraWrapper: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: MOBILE_THEME.border,
    overflow: "hidden",
  },
  scannerCamera: {
    flex: 1,
  },
  connectionHint: {
    color: MOBILE_THEME.mutedForeground,
    fontSize: 12,
    lineHeight: 16,
  },
  footerPad: {
    height: 20,
  },
});
