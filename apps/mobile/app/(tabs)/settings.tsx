import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { Camera } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import {
  Archive,
  Bot,
  Check,
  Moon,
  Monitor,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Wrench,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  type KeybindingCommand,
  type ResolvedKeybindingsConfig,
  type OrchestrationProject,
  type OrchestrationThread,
  type ProviderKind,
  type ServerConfigIssue,
  type ServerLspMarketplacePackage,
  type ServerLspToolsStatus,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ace/contracts";
import type {
  BrowserSearchEngine,
  EditorLineNumbers,
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
  TimestampFormat,
} from "@ace/contracts/settings";
import { newCommandId } from "@ace/shared/ids";
import { useTheme, type ThemeMode } from "../../src/design/ThemeContext";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import {
  IconButton,
  Panel,
  RowLink,
  ScreenBackdrop,
  ScreenHeader,
  SectionTitle,
  StatusBadge,
} from "../../src/design/primitives";
import { useHostStore } from "../../src/store/HostStore";
import { useAggregatedOrchestration } from "../../src/orchestration/mobileData";
import { formatErrorMessage } from "../../src/errors";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";
import { useMobileBrowserHistoryStore } from "../../src/store/MobileBrowserHistoryStore";
import { useMobileBrowserSessionStore } from "../../src/store/MobileBrowserSessionStore";
import {
  runMobileHostDiagnostics,
  type MobileHostDiagnosticsStatus,
} from "../../src/diagnostics/mobileHostDiagnostics";
import {
  runNativePermissionDiagnostics,
  type NativePermissionKind,
  type NativePermissionDiagnosticsStatus,
} from "../../src/diagnostics/nativePermissionDiagnostics";
import {
  encodeShortcutValue,
  filterMobileKeybindings,
  findMobileKeybindingConflicts,
  formatShortcutValue,
  keybindingCommandLabel,
  keybindingWhenExpression,
} from "../../src/settings/mobileKeybindings";
import mobilePackage from "../../package.json";

const MOBILE_APP_VERSION = mobilePackage.version;

interface HostProviderStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly error: string | null;
}

interface HostLspStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly status: ServerLspToolsStatus | null;
  readonly error: string | null;
}

interface HostArchivedStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly error: string | null;
}

interface HostSettingsStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly settings: ServerSettings | null;
  readonly error: string | null;
}

interface HostKeybindingsStatus {
  readonly hostId: string;
  readonly hostName: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: ReadonlyArray<ServerConfigIssue>;
  readonly error: string | null;
}

const THEME_OPTIONS: Array<{ label: string; value: ThemeMode; Icon: LucideIcon }> = [
  { label: "Light", value: "light", Icon: Sun },
  { label: "Dark", value: "dark", Icon: Moon },
  { label: "System", value: "system", Icon: Monitor },
];

const BROWSER_SEARCH_ENGINE_OPTIONS: ReadonlyArray<{
  label: string;
  value: BrowserSearchEngine;
}> = [
  { label: "DuckDuckGo", value: "duckduckgo" },
  { label: "Google", value: "google" },
  { label: "Brave", value: "brave" },
  { label: "Startpage", value: "startpage" },
];

const PROJECT_SORT_OPTIONS: ReadonlyArray<{
  label: string;
  value: SidebarProjectSortOrder;
}> = [
  { label: "Recent", value: "updated_at" },
  { label: "Last prompt", value: "last_user_message" },
  { label: "Created", value: "created_at" },
  { label: "Host order", value: "manual" },
];

const THREAD_SORT_OPTIONS: ReadonlyArray<{
  label: string;
  value: SidebarThreadSortOrder;
}> = [
  { label: "Recent", value: "updated_at" },
  { label: "Last prompt", value: "last_user_message" },
  { label: "Created", value: "created_at" },
];

const TIMESTAMP_FORMAT_OPTIONS: ReadonlyArray<{
  label: string;
  value: TimestampFormat;
}> = [
  { label: "Locale", value: "locale" },
  { label: "12-hour", value: "12-hour" },
  { label: "24-hour", value: "24-hour" },
];

const EDITOR_LINE_NUMBER_OPTIONS: ReadonlyArray<{
  label: string;
  value: EditorLineNumbers;
}> = [
  { label: "Off", value: "off" },
  { label: "On", value: "on" },
  { label: "Relative", value: "relative" },
];

const SETTINGS_PROVIDER_ORDER = [
  "codex",
  "claudeAgent",
  "githubCopilot",
  "cursor",
  "gemini",
  "opencode",
] as const satisfies ReadonlyArray<ProviderKind>;

interface CommonProviderSettingsPatch {
  readonly enabled?: boolean;
  readonly binaryPath?: string;
  readonly customModels?: string[];
}

function providerSettingsPatch(
  provider: ProviderKind,
  patch: CommonProviderSettingsPatch,
): ServerSettingsPatch {
  switch (provider) {
    case "codex":
      return { providers: { codex: patch } };
    case "claudeAgent":
      return { providers: { claudeAgent: patch } };
    case "githubCopilot":
      return { providers: { githubCopilot: patch } };
    case "cursor":
      return { providers: { cursor: patch } };
    case "gemini":
      return { providers: { gemini: patch } };
    case "opencode":
      return { providers: { opencode: patch } };
  }
}

function customModelInputValue(models: ReadonlyArray<string>): string {
  return models.join(", ");
}

function parseCustomModelInput(value: string): string[] {
  return value
    .split(/[\n,]/u)
    .map((model) => model.trim())
    .filter(Boolean);
}

function providerModelOptions(
  hostId: string,
  provider: ProviderKind,
  providerStatuses: ReadonlyArray<HostProviderStatus>,
  settings: ServerSettings,
): ReadonlyArray<string> {
  const discovered =
    providerStatuses
      .find((status) => status.hostId === hostId)
      ?.providers.find((candidate) => candidate.provider === provider)
      ?.models.map((model) => model.slug) ?? [];
  const configured = settings.providers[provider].customModels;
  return Array.from(
    new Set([
      ...discovered,
      ...configured,
      settings.textGenerationModelSelection.provider === provider
        ? settings.textGenerationModelSelection.model
        : DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider],
    ]),
  ).filter(Boolean);
}

function defaultLspCommandForPackage(packageName: string): string {
  const normalized = packageName.trim().split("/").findLast(Boolean) ?? packageName;
  return normalized.replace(/^@/u, "") || packageName;
}

function defaultLspLanguageIdForPackage(packageName: string): string {
  return (
    defaultLspCommandForPackage(packageName)
      .replace(/(?:-language-server|-server|-lsp)$/u, "")
      .replace(/[^a-z0-9]+/giu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase() || "plaintext"
  );
}

function ArchivedRow({
  title,
  meta,
  restoring,
  onRestore,
}: {
  title: string;
  meta: string;
  restoring: boolean;
  onRestore: () => void;
}) {
  const { colors } = useTheme();

  return (
    <View style={styles.archiveRow}>
      <View
        style={[
          styles.archiveIcon,
          {
            backgroundColor: withAlpha(colors.foreground, 0.08),
          },
        ]}
      >
        <Archive size={15} color={colors.secondaryLabel} strokeWidth={2.1} />
      </View>
      <View style={styles.archiveCopy}>
        <Text style={[styles.providerName, { color: colors.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.providerMeta, { color: colors.secondaryLabel }]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Pressable
        disabled={restoring}
        onPress={onRestore}
        style={[
          styles.restoreButton,
          {
            backgroundColor: withAlpha(colors.primary, 0.12),
            borderColor: withAlpha(colors.primary, 0.22),
          },
          restoring && styles.disabled,
        ]}
      >
        {restoring ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Text style={[styles.restoreButtonText, { color: colors.primary }]}>Restore</Text>
        )}
      </Pressable>
    </View>
  );
}

function SettingsToggle({
  label,
  enabled,
  onPress,
  disabled = false,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.settingToggle,
        {
          backgroundColor: enabled ? withAlpha(colors.primary, 0.12) : colors.surfaceSecondary,
          borderColor: enabled ? withAlpha(colors.primary, 0.34) : colors.elevatedBorder,
        },
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[
          styles.settingToggleText,
          { color: enabled ? colors.primary : colors.secondaryLabel },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, themeMode, setThemeMode } = useTheme();
  const browserSearchEngine = useMobilePreferencesStore((state) => state.browserSearchEngine);
  const browserHistoryCount = useMobileBrowserHistoryStore((state) => state.history.length);
  const clearBrowserHistory = useMobileBrowserHistoryStore((state) => state.clearHistory);
  const browserTabCount = useMobileBrowserSessionStore((state) => state.tabs.length);
  const clearBrowserSession = useMobileBrowserSessionStore((state) => state.clearSession);
  const confirmThreadArchive = useMobilePreferencesStore((state) => state.confirmThreadArchive);
  const confirmThreadDelete = useMobilePreferencesStore((state) => state.confirmThreadDelete);
  const diffWordWrap = useMobilePreferencesStore((state) => state.diffWordWrap);
  const editorLineNumbers = useMobilePreferencesStore((state) => state.editorLineNumbers);
  const editorRenderWhitespace = useMobilePreferencesStore((state) => state.editorRenderWhitespace);
  const editorSuggestions = useMobilePreferencesStore((state) => state.editorSuggestions);
  const editorWordWrap = useMobilePreferencesStore((state) => state.editorWordWrap);
  const sidebarProjectSortOrder = useMobilePreferencesStore(
    (state) => state.sidebarProjectSortOrder,
  );
  const sidebarThreadSortOrder = useMobilePreferencesStore((state) => state.sidebarThreadSortOrder);
  const timestampFormat = useMobilePreferencesStore((state) => state.timestampFormat);
  const setBrowserSearchEngine = useMobilePreferencesStore((state) => state.setBrowserSearchEngine);
  const setConfirmThreadArchive = useMobilePreferencesStore(
    (state) => state.setConfirmThreadArchive,
  );
  const setConfirmThreadDelete = useMobilePreferencesStore((state) => state.setConfirmThreadDelete);
  const setDiffWordWrap = useMobilePreferencesStore((state) => state.setDiffWordWrap);
  const setEditorLineNumbers = useMobilePreferencesStore((state) => state.setEditorLineNumbers);
  const setEditorRenderWhitespace = useMobilePreferencesStore(
    (state) => state.setEditorRenderWhitespace,
  );
  const setEditorSuggestions = useMobilePreferencesStore((state) => state.setEditorSuggestions);
  const setEditorWordWrap = useMobilePreferencesStore((state) => state.setEditorWordWrap);
  const setSidebarProjectSortOrder = useMobilePreferencesStore(
    (state) => state.setSidebarProjectSortOrder,
  );
  const setSidebarThreadSortOrder = useMobilePreferencesStore(
    (state) => state.setSidebarThreadSortOrder,
  );
  const setTimestampFormat = useMobilePreferencesStore((state) => state.setTimestampFormat);
  const confirmClearBrowserHistory = useCallback(() => {
    if (browserHistoryCount === 0) {
      return;
    }
    Alert.alert(
      "Clear browser history?",
      "This removes mobile browser history and address suggestions stored on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: clearBrowserHistory,
        },
      ],
    );
  }, [browserHistoryCount, clearBrowserHistory]);
  const confirmClearBrowserSession = useCallback(() => {
    if (browserTabCount === 0) {
      return;
    }
    Alert.alert(
      "Close saved browser tabs?",
      "This clears the mobile browser tabs saved on this device. Browser history is unchanged.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: clearBrowserSession,
        },
      ],
    );
  }, [browserTabCount, clearBrowserSession]);
  const hosts = useHostStore((state) => state.hosts);
  const { connections } = useAggregatedOrchestration();
  const [providerStatuses, setProviderStatuses] = useState<ReadonlyArray<HostProviderStatus>>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [lspStatuses, setLspStatuses] = useState<ReadonlyArray<HostLspStatus>>([]);
  const [loadingLspTools, setLoadingLspTools] = useState(false);
  const [installingLspHostId, setInstallingLspHostId] = useState<string | null>(null);
  const [lspSearchQueryByHostId, setLspSearchQueryByHostId] = useState<Record<string, string>>({});
  const [lspSearchResultsByHostId, setLspSearchResultsByHostId] = useState<
    Record<string, ReadonlyArray<ServerLspMarketplacePackage>>
  >({});
  const [searchingLspHostId, setSearchingLspHostId] = useState<string | null>(null);
  const [installingLspPackageId, setInstallingLspPackageId] = useState<string | null>(null);
  const [archivedStatuses, setArchivedStatuses] = useState<ReadonlyArray<HostArchivedStatus>>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [restoringArchivedId, setRestoringArchivedId] = useState<string | null>(null);
  const [settingsStatuses, setSettingsStatuses] = useState<ReadonlyArray<HostSettingsStatus>>([]);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [updatingSettingsHostId, setUpdatingSettingsHostId] = useState<string | null>(null);
  const [keybindingsStatuses, setKeybindingsStatuses] = useState<
    ReadonlyArray<HostKeybindingsStatus>
  >([]);
  const [loadingKeybindings, setLoadingKeybindings] = useState(false);
  const [updatingKeybindingId, setUpdatingKeybindingId] = useState<string | null>(null);
  const [keybindingDrafts, setKeybindingDrafts] = useState<Record<string, string>>({});
  const [keybindingErrors, setKeybindingErrors] = useState<Record<string, string>>({});
  const [keybindingQueries, setKeybindingQueries] = useState<Record<string, string>>({});
  const [diagnosticsStatuses, setDiagnosticsStatuses] = useState<
    ReadonlyArray<MobileHostDiagnosticsStatus>
  >([]);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [nativePermissionStatuses, setNativePermissionStatuses] = useState<
    ReadonlyArray<NativePermissionDiagnosticsStatus>
  >([]);
  const [checkingNativePermissions, setCheckingNativePermissions] = useState(false);
  const [requestingNativePermission, setRequestingNativePermission] =
    useState<NativePermissionKind | null>(null);
  const [openCodeModelQueryByHostId, setOpenCodeModelQueryByHostId] = useState<
    Record<string, string>
  >({});
  const [openCodeModelResultsByHostId, setOpenCodeModelResultsByHostId] = useState<
    Record<string, ReadonlyArray<ServerProvider["models"][number]>>
  >({});
  const [searchingOpenCodeModelHostId, setSearchingOpenCodeModelHostId] = useState<string | null>(
    null,
  );
  const connectedHostCount = connections.filter(
    (connection) => connection.status.kind === "connected",
  ).length;
  const connectedConnections = useMemo(
    () => connections.filter((connection) => connection.status.kind === "connected"),
    [connections],
  );

  const runDiagnostics = useCallback(async () => {
    if (connectedConnections.length === 0) {
      setDiagnosticsStatuses([]);
      return;
    }

    setRunningDiagnostics(true);
    try {
      const nextStatuses = await Promise.all(
        connectedConnections.map((connection) =>
          runMobileHostDiagnostics({
            hostId: connection.host.id,
            hostName: connection.host.name,
            client: {
              server: connection.client.server,
              orchestration: connection.client.orchestration,
              projects: connection.client.projects,
              git: connection.client.git,
              terminal: connection.client.terminal,
            },
          }),
        ),
      );
      setDiagnosticsStatuses(nextStatuses);
    } finally {
      setRunningDiagnostics(false);
    }
  }, [connectedConnections]);

  const checkNativePermissions = useCallback(async () => {
    setCheckingNativePermissions(true);
    try {
      const statuses = await runNativePermissionDiagnostics([
        {
          kind: "notifications",
          label: "Notifications",
          getPermission: Notifications.getPermissionsAsync,
        },
        {
          kind: "camera",
          label: "Camera",
          getPermission: Camera.getCameraPermissionsAsync,
        },
        {
          kind: "photo-library",
          label: "Photo Library",
          getPermission: () => ImagePicker.getMediaLibraryPermissionsAsync(false),
        },
      ]);
      setNativePermissionStatuses(statuses);
    } finally {
      setCheckingNativePermissions(false);
    }
  }, []);

  const requestNativePermission = useCallback(
    async (kind: NativePermissionKind) => {
      setRequestingNativePermission(kind);
      try {
        if (kind === "notifications") {
          await Notifications.requestPermissionsAsync();
        } else if (kind === "camera") {
          await Camera.requestCameraPermissionsAsync();
        } else {
          await ImagePicker.requestMediaLibraryPermissionsAsync(false);
        }
        await checkNativePermissions();
      } finally {
        setRequestingNativePermission(null);
      }
    },
    [checkNativePermissions],
  );

  useEffect(() => {
    void checkNativePermissions();
  }, [checkNativePermissions]);

  const loadProviderStatuses = useCallback(
    async (refreshProviders: boolean) => {
      if (connectedConnections.length === 0) {
        setProviderStatuses([]);
        return;
      }

      setLoadingProviders(true);
      try {
        const nextStatuses = await Promise.all(
          connectedConnections.map(async (connection): Promise<HostProviderStatus> => {
            try {
              const result = refreshProviders
                ? await connection.client.server.refreshProviders()
                : await connection.client.server.getConfig();
              return {
                hostId: connection.host.id,
                hostName: connection.host.name,
                providers: result.providers,
                error: null,
              };
            } catch (cause) {
              return {
                hostId: connection.host.id,
                hostName: connection.host.name,
                providers: [],
                error: formatErrorMessage(cause),
              };
            }
          }),
        );
        setProviderStatuses(nextStatuses);
      } finally {
        setLoadingProviders(false);
      }
    },
    [connectedConnections],
  );

  useEffect(() => {
    void loadProviderStatuses(false);
  }, [loadProviderStatuses]);

  const loadKeybindingsStatuses = useCallback(async () => {
    if (connectedConnections.length === 0) {
      setKeybindingsStatuses([]);
      return;
    }

    setLoadingKeybindings(true);
    try {
      const nextStatuses = await Promise.all(
        connectedConnections.map(async (connection): Promise<HostKeybindingsStatus> => {
          try {
            const config = await connection.client.server.getConfig();
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              keybindings: config.keybindings,
              issues: config.issues,
              error: null,
            };
          } catch (cause) {
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              keybindings: [],
              issues: [],
              error: formatErrorMessage(cause),
            };
          }
        }),
      );
      setKeybindingsStatuses(nextStatuses);
    } finally {
      setLoadingKeybindings(false);
    }
  }, [connectedConnections]);

  useEffect(() => {
    void loadKeybindingsStatuses();
  }, [loadKeybindingsStatuses]);

  const loadLspStatuses = useCallback(async () => {
    if (connectedConnections.length === 0) {
      setLspStatuses([]);
      return;
    }

    setLoadingLspTools(true);
    try {
      const nextStatuses = await Promise.all(
        connectedConnections.map(async (connection): Promise<HostLspStatus> => {
          try {
            const status = await connection.client.server.getLspToolsStatus();
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              status,
              error: null,
            };
          } catch (cause) {
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              status: null,
              error: formatErrorMessage(cause),
            };
          }
        }),
      );
      setLspStatuses(nextStatuses);
    } finally {
      setLoadingLspTools(false);
    }
  }, [connectedConnections]);

  useEffect(() => {
    void loadLspStatuses();
  }, [loadLspStatuses]);

  const installLspTools = useCallback(
    async (hostId: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection) {
        return;
      }

      setInstallingLspHostId(hostId);
      try {
        const status = await connection.client.server.installLspTools();
        setLspStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, status, error: null } : entry,
          ),
        );
      } catch (cause) {
        setLspStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, error: formatErrorMessage(cause) } : entry,
          ),
        );
      } finally {
        setInstallingLspHostId(null);
      }
    },
    [connectedConnections],
  );

  const searchLspMarketplace = useCallback(
    async (hostId: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      const query = lspSearchQueryByHostId[hostId]?.trim() ?? "";
      if (!connection || connection.status.kind !== "connected" || query.length === 0) {
        return;
      }

      setSearchingLspHostId(hostId);
      try {
        const result = await connection.client.server.searchLspMarketplace({
          query,
          limit: 5,
        });
        setLspSearchResultsByHostId((current) => ({
          ...current,
          [hostId]: result.packages,
        }));
      } catch (cause) {
        setLspStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, error: formatErrorMessage(cause) } : entry,
          ),
        );
      } finally {
        setSearchingLspHostId(null);
      }
    },
    [connectedConnections, lspSearchQueryByHostId],
  );

  const installMarketplaceLspPackage = useCallback(
    async (hostId: string, pkg: ServerLspMarketplacePackage) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection || connection.status.kind !== "connected") {
        return;
      }

      const installId = `${hostId}:${pkg.packageName}`;
      setInstallingLspPackageId(installId);
      try {
        const status = await connection.client.server.installLspTool({
          packageName: pkg.packageName,
          command: defaultLspCommandForPackage(pkg.packageName),
          label: pkg.packageName,
          installer: "npm",
          description: pkg.description ?? `Language server package ${pkg.packageName}`,
          languageIds: [defaultLspLanguageIdForPackage(pkg.packageName)],
          fileExtensions: [`.${defaultLspLanguageIdForPackage(pkg.packageName)}`],
        });
        setLspStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, status, error: null } : entry,
          ),
        );
      } catch (cause) {
        setLspStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, error: formatErrorMessage(cause) } : entry,
          ),
        );
      } finally {
        setInstallingLspPackageId(null);
      }
    },
    [connectedConnections],
  );

  const loadArchivedStatuses = useCallback(async () => {
    if (connectedConnections.length === 0) {
      setArchivedStatuses([]);
      return;
    }

    setLoadingArchived(true);
    try {
      const nextStatuses = await Promise.all(
        connectedConnections.map(async (connection): Promise<HostArchivedStatus> => {
          try {
            const snapshot = await connection.client.orchestration.getSnapshot();
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              projects: snapshot.projects.filter(
                (project) => !project.deletedAt && Boolean(project.archivedAt),
              ),
              threads: snapshot.threads.filter(
                (thread) => !thread.deletedAt && Boolean(thread.archivedAt),
              ),
              error: null,
            };
          } catch (cause) {
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              projects: [],
              threads: [],
              error: formatErrorMessage(cause),
            };
          }
        }),
      );
      setArchivedStatuses(nextStatuses);
    } finally {
      setLoadingArchived(false);
    }
  }, [connectedConnections]);

  useEffect(() => {
    void loadArchivedStatuses();
  }, [loadArchivedStatuses]);

  const restoreArchivedProject = useCallback(
    async (hostId: string, projectId: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection || connection.status.kind !== "connected") {
        return;
      }

      setRestoringArchivedId(`project:${hostId}:${projectId}`);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: projectId as never,
          archivedAt: null,
        });
        await loadArchivedStatuses();
      } finally {
        setRestoringArchivedId(null);
      }
    },
    [connectedConnections, loadArchivedStatuses],
  );

  const restoreArchivedThread = useCallback(
    async (hostId: string, threadId: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection || connection.status.kind !== "connected") {
        return;
      }

      setRestoringArchivedId(`thread:${hostId}:${threadId}`);
      try {
        await connection.client.orchestration.dispatchCommand({
          type: "thread.unarchive",
          commandId: newCommandId(),
          threadId: threadId as never,
        });
        await loadArchivedStatuses();
      } finally {
        setRestoringArchivedId(null);
      }
    },
    [connectedConnections, loadArchivedStatuses],
  );

  const loadSettingsStatuses = useCallback(async () => {
    if (connectedConnections.length === 0) {
      setSettingsStatuses([]);
      return;
    }

    setLoadingSettings(true);
    try {
      const nextStatuses = await Promise.all(
        connectedConnections.map(async (connection): Promise<HostSettingsStatus> => {
          try {
            const settings = await connection.client.server.getSettings();
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              settings,
              error: null,
            };
          } catch (cause) {
            return {
              hostId: connection.host.id,
              hostName: connection.host.name,
              settings: null,
              error: formatErrorMessage(cause),
            };
          }
        }),
      );
      setSettingsStatuses(nextStatuses);
    } finally {
      setLoadingSettings(false);
    }
  }, [connectedConnections]);

  useEffect(() => {
    void loadSettingsStatuses();
  }, [loadSettingsStatuses]);

  const updateHostSettings = useCallback(
    async (hostId: string, patch: ServerSettingsPatch) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection || connection.status.kind !== "connected") {
        return;
      }

      setUpdatingSettingsHostId(hostId);
      try {
        const settings = await connection.client.server.updateSettings(patch);
        setSettingsStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, settings, error: null } : entry,
          ),
        );
      } catch (cause) {
        setSettingsStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, error: formatErrorMessage(cause) } : entry,
          ),
        );
      } finally {
        setUpdatingSettingsHostId(null);
      }
    },
    [connectedConnections],
  );

  const upsertKeybindingForHost = useCallback(
    async (hostId: string, command: KeybindingCommand, currentKey: string, when?: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      if (!connection || connection.status.kind !== "connected") {
        return;
      }

      const draftId = `${hostId}:${command}`;
      const key = (keybindingDrafts[draftId] ?? currentKey).trim();
      if (!key) {
        setKeybindingErrors((current) => ({
          ...current,
          [draftId]: "Enter a shortcut before saving.",
        }));
        return;
      }

      setUpdatingKeybindingId(draftId);
      setKeybindingErrors((current) => {
        const { [draftId]: _removed, ...rest } = current;
        return rest;
      });
      try {
        const result = await connection.client.server.upsertKeybinding({
          command,
          key,
          ...(when ? { when } : {}),
        });
        setKeybindingsStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId
              ? { ...entry, keybindings: result.keybindings, issues: result.issues, error: null }
              : entry,
          ),
        );
        setKeybindingDrafts((current) => {
          const { [draftId]: _removed, ...rest } = current;
          return rest;
        });
      } catch (cause) {
        setKeybindingErrors((current) => ({
          ...current,
          [draftId]: formatErrorMessage(cause),
        }));
      } finally {
        setUpdatingKeybindingId(null);
      }
    },
    [connectedConnections, keybindingDrafts],
  );

  const searchOpenCodeModels = useCallback(
    async (hostId: string) => {
      const connection = connectedConnections.find((candidate) => candidate.host.id === hostId);
      const query = openCodeModelQueryByHostId[hostId]?.trim() ?? "";
      if (!connection || connection.status.kind !== "connected" || query.length === 0) {
        return;
      }

      setSearchingOpenCodeModelHostId(hostId);
      try {
        const result = await connection.client.server.searchOpenCodeModels({
          query,
          limit: 8,
          offset: 0,
        });
        setOpenCodeModelResultsByHostId((current) => ({
          ...current,
          [hostId]: result.models,
        }));
        setSettingsStatuses((current) =>
          current.map((entry) => (entry.hostId === hostId ? { ...entry, error: null } : entry)),
        );
      } catch (cause) {
        setSettingsStatuses((current) =>
          current.map((entry) =>
            entry.hostId === hostId ? { ...entry, error: formatErrorMessage(cause) } : entry,
          ),
        );
      } finally {
        setSearchingOpenCodeModelHostId(null);
      }
    },
    [connectedConnections, openCodeModelQueryByHostId],
  );

  const addOpenCodeModel = useCallback(
    async (hostId: string, settings: ServerSettings, model: string) => {
      const normalized = model.trim();
      if (!normalized) {
        return;
      }

      const customModels = settings.providers.opencode.customModels;
      if (customModels.includes(normalized)) {
        return;
      }

      await updateHostSettings(hostId, {
        providers: {
          opencode: {
            customModels: [...customModels, normalized],
          },
        },
      });
    },
    [updateHostSettings],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingHorizontal: Layout.pagePadding,
          paddingBottom: insets.bottom + 120,
        }}
      >
        <ScreenHeader
          title="Settings"
          action={<StatusBadge label={`${connectedHostCount} online`} tone="success" />}
        />

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Hosts</SectionTitle>
            <IconButton icon={Plus} label="Pair" onPress={() => router.push("/pairing")} />
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {hosts.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No hosts paired
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Add a desktop target to enable thread browsing and remote control.
                </Text>
              </View>
            ) : (
              hosts.map((host, index) => {
                const isConnected = connections.some(
                  (connection) =>
                    connection.host.id === host.id && connection.status.kind === "connected",
                );

                return (
                  <View key={host.id}>
                    <RowLink
                      title={host.name}
                      meta={isConnected ? "Connected and syncing" : "Offline"}
                      tone={isConnected ? "success" : "muted"}
                      onPress={() =>
                        router.push({
                          pathname: "/settings/device/[id]",
                          params: { id: host.id },
                        })
                      }
                    />
                    {index < hosts.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Appearance</SectionTitle>
          <Panel padded={false} style={styles.panelShell}>
            {THEME_OPTIONS.map((option, index) => {
              const selected = option.value === themeMode;
              const Icon = option.Icon;

              return (
                <Pressable
                  key={option.value}
                  onPress={() => setThemeMode(option.value)}
                  style={({ pressed }) => [
                    styles.themeRow,
                    {
                      backgroundColor: pressed ? withAlpha(colors.foreground, 0.04) : "transparent",
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.themeIcon,
                      {
                        backgroundColor: withAlpha(colors.primary, 0.12),
                      },
                    ]}
                  >
                    <Icon size={17} color={colors.primary} strokeWidth={2.2} />
                  </View>
                  <View style={styles.themeCopy}>
                    <Text style={[styles.themeTitle, { color: colors.foreground }]}>
                      {option.label}
                    </Text>
                    <Text style={[styles.themeMeta, { color: colors.secondaryLabel }]}>
                      {option.value === "system"
                        ? "Match the device"
                        : option.value === "dark"
                          ? "Low-glare workspace"
                          : "Bright canvas"}
                    </Text>
                  </View>
                  {selected ? <Check size={18} color={colors.primary} strokeWidth={2.8} /> : null}
                  {index < THEME_OPTIONS.length - 1 ? (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  ) : null}
                </Pressable>
              );
            })}
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Lists</SectionTitle>
          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Project order
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Controls how projects are grouped across connected hosts.
            </Text>
            <View style={styles.browserEngineGrid}>
              {PROJECT_SORT_OPTIONS.map((option) => {
                const selected = option.value === sidebarProjectSortOrder;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setSidebarProjectSortOrder(option.value)}
                    style={[
                      styles.browserEngineButton,
                      {
                        backgroundColor: selected
                          ? withAlpha(colors.primary, 0.12)
                          : colors.surfaceSecondary,
                        borderColor: selected
                          ? withAlpha(colors.primary, 0.34)
                          : colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.settingSegmentLabel,
                        { color: selected ? colors.primary : colors.secondaryLabel },
                      ]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Panel>

          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Thread order
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Applies to Home, Notifications, project details, and host thread lists.
            </Text>
            <View style={styles.browserEngineGrid}>
              {THREAD_SORT_OPTIONS.map((option) => {
                const selected = option.value === sidebarThreadSortOrder;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setSidebarThreadSortOrder(option.value)}
                    style={[
                      styles.browserEngineButton,
                      {
                        backgroundColor: selected
                          ? withAlpha(colors.primary, 0.12)
                          : colors.surfaceSecondary,
                        borderColor: selected
                          ? withAlpha(colors.primary, 0.34)
                          : colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.settingSegmentLabel,
                        { color: selected ? colors.primary : colors.secondaryLabel },
                      ]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Time</SectionTitle>
          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Timestamp format
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Used for exact times in mobile thread and file workflows.
            </Text>
            <View style={styles.browserEngineGrid}>
              {TIMESTAMP_FORMAT_OPTIONS.map((option) => {
                const selected = option.value === timestampFormat;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setTimestampFormat(option.value)}
                    style={[
                      styles.browserEngineButton,
                      {
                        backgroundColor: selected
                          ? withAlpha(colors.primary, 0.12)
                          : colors.surfaceSecondary,
                        borderColor: selected
                          ? withAlpha(colors.primary, 0.34)
                          : colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.settingSegmentLabel,
                        { color: selected ? colors.primary : colors.secondaryLabel },
                      ]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Editor</SectionTitle>
          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Line numbers
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Controls the gutter in the mobile workspace editor.
            </Text>
            <View style={styles.browserEngineGrid}>
              {EDITOR_LINE_NUMBER_OPTIONS.map((option) => {
                const selected = option.value === editorLineNumbers;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setEditorLineNumbers(option.value)}
                    style={[
                      styles.browserEngineButton,
                      {
                        backgroundColor: selected
                          ? withAlpha(colors.primary, 0.12)
                          : colors.surfaceSecondary,
                        borderColor: selected
                          ? withAlpha(colors.primary, 0.34)
                          : colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.settingSegmentLabel,
                        { color: selected ? colors.primary : colors.secondaryLabel },
                      ]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text
              style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel, marginTop: 14 }]}
            >
              Workspace editor
            </Text>
            <View style={styles.settingToggleGrid}>
              <SettingsToggle
                label="Wrap"
                enabled={editorWordWrap}
                onPress={() => setEditorWordWrap(!editorWordWrap)}
              />
              <SettingsToggle
                label="Whitespace"
                enabled={editorRenderWhitespace}
                onPress={() => setEditorRenderWhitespace(!editorRenderWhitespace)}
              />
              <SettingsToggle
                label="Complete"
                enabled={editorSuggestions}
                onPress={() => setEditorSuggestions(!editorSuggestions)}
              />
              <SettingsToggle
                label="Diff wrap"
                enabled={diffWordWrap}
                onPress={() => setDiffWordWrap(!diffWordWrap)}
              />
            </View>
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Browser</SectionTitle>
          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Search engine
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Used when mobile browser input is not a URL.
            </Text>
            <View style={styles.browserEngineGrid}>
              {BROWSER_SEARCH_ENGINE_OPTIONS.map((option) => {
                const selected = option.value === browserSearchEngine;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => setBrowserSearchEngine(option.value)}
                    style={[
                      styles.browserEngineButton,
                      {
                        backgroundColor: selected
                          ? withAlpha(colors.primary, 0.12)
                          : colors.surfaceSecondary,
                        borderColor: selected
                          ? withAlpha(colors.primary, 0.34)
                          : colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.settingSegmentLabel,
                        { color: selected ? colors.primary : colors.secondaryLabel },
                      ]}
                      numberOfLines={1}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={[styles.settingsDivider, { backgroundColor: colors.separator }]} />
            <View style={styles.browserDataRow}>
              <View style={styles.browserDataCopy}>
                <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
                  Browser history
                </Text>
                <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
                  {browserHistoryCount === 0
                    ? "No mobile browser visits stored on this device."
                    : `${browserHistoryCount} stored ${browserHistoryCount === 1 ? "visit" : "visits"} for address suggestions.`}
                </Text>
              </View>
              <Pressable
                disabled={browserHistoryCount === 0}
                onPress={confirmClearBrowserHistory}
                style={[
                  styles.clearHistoryButton,
                  {
                    backgroundColor:
                      browserHistoryCount > 0
                        ? withAlpha(colors.red, 0.1)
                        : colors.surfaceSecondary,
                    borderColor:
                      browserHistoryCount > 0 ? withAlpha(colors.red, 0.2) : colors.elevatedBorder,
                  },
                  browserHistoryCount === 0 && styles.disabled,
                ]}
              >
                <Text
                  style={[
                    styles.clearHistoryButtonText,
                    { color: browserHistoryCount > 0 ? colors.red : colors.secondaryLabel },
                  ]}
                >
                  Clear
                </Text>
              </Pressable>
            </View>
            <View style={[styles.settingsDivider, { backgroundColor: colors.separator }]} />
            <View style={styles.browserDataRow}>
              <View style={styles.browserDataCopy}>
                <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
                  Saved tabs
                </Text>
                <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
                  {browserTabCount === 0
                    ? "No mobile browser tabs are saved on this device."
                    : `${browserTabCount} saved ${browserTabCount === 1 ? "tab" : "tabs"} will reopen with the browser.`}
                </Text>
              </View>
              <Pressable
                disabled={browserTabCount === 0}
                onPress={confirmClearBrowserSession}
                style={[
                  styles.clearHistoryButton,
                  {
                    backgroundColor:
                      browserTabCount > 0 ? withAlpha(colors.red, 0.1) : colors.surfaceSecondary,
                    borderColor:
                      browserTabCount > 0 ? withAlpha(colors.red, 0.2) : colors.elevatedBorder,
                  },
                  browserTabCount === 0 && styles.disabled,
                ]}
              >
                <Text
                  style={[
                    styles.clearHistoryButtonText,
                    { color: browserTabCount > 0 ? colors.red : colors.secondaryLabel },
                  ]}
                >
                  Clear
                </Text>
              </Pressable>
            </View>
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>Confirmations</SectionTitle>
          <Panel style={styles.browserPanel}>
            <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
              Thread actions
            </Text>
            <Text style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}>
              Require confirmation before archive or delete actions on this device.
            </Text>
            <View style={styles.settingToggleGrid}>
              <SettingsToggle
                label="Archive"
                enabled={confirmThreadArchive}
                onPress={() => setConfirmThreadArchive(!confirmThreadArchive)}
              />
              <SettingsToggle
                label="Delete"
                enabled={confirmThreadDelete}
                onPress={() => setConfirmThreadDelete(!confirmThreadDelete)}
              />
            </View>
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Keybindings</SectionTitle>
            <Pressable
              disabled={loadingKeybindings || connectedConnections.length === 0}
              onPress={() => void loadKeybindingsStatuses()}
              style={[
                styles.refreshButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (loadingKeybindings || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {loadingKeybindings ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
            </Pressable>
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {keybindingsStatuses.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No keybinding status
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Connect a host to inspect and edit desktop keyboard shortcuts from mobile.
                </Text>
              </View>
            ) : (
              keybindingsStatuses.map((status, hostIndex) => {
                const query = keybindingQueries[status.hostId] ?? "";
                const filteredBindings = filterMobileKeybindings(status.keybindings, query);
                const visibleBindings = filteredBindings.slice(0, 20);
                const conflicts = findMobileKeybindingConflicts(status.keybindings);
                return (
                  <View key={status.hostId} style={styles.settingsHostBlock}>
                    <View style={styles.settingsHostHeader}>
                      <View>
                        <Text style={[styles.settingsHostName, { color: colors.foreground }]}>
                          {status.hostName}
                        </Text>
                        <Text style={[styles.settingsHostMeta, { color: colors.secondaryLabel }]}>
                          {status.keybindings.length} shortcuts
                        </Text>
                      </View>
                      <StatusBadge
                        label={
                          status.issues.length > 0
                            ? `${status.issues.length} issues`
                            : conflicts.length > 0
                              ? `${conflicts.length} conflicts`
                              : "ok"
                        }
                        tone={
                          status.issues.length > 0 || conflicts.length > 0 ? "warning" : "success"
                        }
                      />
                    </View>
                    {status.error ? (
                      <Text style={[styles.errorText, { color: colors.red }]}>{status.error}</Text>
                    ) : (
                      <View style={styles.keybindingList}>
                        <TextInput
                          value={query}
                          onChangeText={(value) =>
                            setKeybindingQueries((current) => ({
                              ...current,
                              [status.hostId]: value,
                            }))
                          }
                          autoCapitalize="none"
                          autoCorrect={false}
                          placeholder="Search shortcuts, commands, or contexts"
                          placeholderTextColor={colors.muted}
                          style={[
                            styles.keybindingSearchInput,
                            {
                              color: colors.foreground,
                              backgroundColor: colors.surfaceSecondary,
                              borderColor: colors.elevatedBorder,
                            },
                          ]}
                        />
                        <Text style={[styles.keybindingCount, { color: colors.tertiaryLabel }]}>
                          {filteredBindings.length} of {status.keybindings.length} shortcuts
                        </Text>
                        {status.issues.map((issue) => (
                          <Text
                            key={`${issue.kind}:${issue.message}`}
                            style={[styles.errorText, { color: colors.orange }]}
                          >
                            {issue.message}
                          </Text>
                        ))}
                        {conflicts.slice(0, 4).map((conflict) => (
                          <Text
                            key={`${conflict.shortcut}:${conflict.when ?? ""}`}
                            style={[styles.errorText, { color: colors.orange }]}
                          >
                            Conflict: {conflict.shortcut}
                            {conflict.when ? ` when ${conflict.when}` : ""} is shared by{" "}
                            {conflict.commands.map(keybindingCommandLabel).join(", ")}
                          </Text>
                        ))}
                        {conflicts.length > 4 ? (
                          <Text style={[styles.keybindingMeta, { color: colors.tertiaryLabel }]}>
                            {conflicts.length - 4} more shortcut conflicts hidden.
                          </Text>
                        ) : null}
                        {visibleBindings.length === 0 ? (
                          <Text style={[styles.keybindingMeta, { color: colors.secondaryLabel }]}>
                            No shortcuts match this filter.
                          </Text>
                        ) : null}
                        {visibleBindings.map((binding) => {
                          const draftId = `${status.hostId}:${binding.command}`;
                          const keyValue = encodeShortcutValue(binding.shortcut);
                          const when = keybindingWhenExpression(binding.whenAst);
                          const draft = keybindingDrafts[draftId] ?? keyValue;
                          const dirty = draft.trim() !== keyValue;
                          const saving = updatingKeybindingId === draftId;
                          return (
                            <View
                              key={`${binding.command}:${when ?? ""}`}
                              style={[
                                styles.keybindingRow,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                              ]}
                            >
                              <View style={styles.keybindingCopy}>
                                <Text
                                  style={[styles.keybindingTitle, { color: colors.foreground }]}
                                  numberOfLines={1}
                                >
                                  {keybindingCommandLabel(binding.command)}
                                </Text>
                                <Text
                                  style={[styles.keybindingMeta, { color: colors.secondaryLabel }]}
                                  numberOfLines={1}
                                >
                                  {binding.command}
                                  {when ? ` · ${when}` : ""}
                                </Text>
                              </View>
                              <View style={styles.keybindingEditor}>
                                <TextInput
                                  value={draft}
                                  onChangeText={(value) =>
                                    setKeybindingDrafts((current) => ({
                                      ...current,
                                      [draftId]: value,
                                    }))
                                  }
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                  placeholder="cmd+k"
                                  placeholderTextColor={colors.muted}
                                  style={[
                                    styles.keybindingInput,
                                    {
                                      color: colors.foreground,
                                      backgroundColor: colors.surface,
                                      borderColor: keybindingErrors[draftId]
                                        ? colors.red
                                        : colors.elevatedBorder,
                                    },
                                  ]}
                                />
                                <Pressable
                                  disabled={!dirty || saving}
                                  onPress={() =>
                                    void upsertKeybindingForHost(
                                      status.hostId,
                                      binding.command,
                                      keyValue,
                                      when,
                                    )
                                  }
                                  style={[
                                    styles.keybindingSaveButton,
                                    {
                                      backgroundColor: dirty ? colors.primary : colors.surface,
                                      borderColor: dirty ? colors.primary : colors.elevatedBorder,
                                    },
                                    (!dirty || saving) && styles.disabled,
                                  ]}
                                >
                                  {saving ? (
                                    <ActivityIndicator color={colors.primaryForeground} />
                                  ) : (
                                    <Text
                                      style={[
                                        styles.keybindingSaveLabel,
                                        {
                                          color: dirty
                                            ? colors.primaryForeground
                                            : colors.secondaryLabel,
                                        },
                                      ]}
                                    >
                                      Save
                                    </Text>
                                  )}
                                </Pressable>
                              </View>
                              {keybindingErrors[draftId] ? (
                                <Text style={[styles.errorText, { color: colors.red }]}>
                                  {keybindingErrors[draftId]}
                                </Text>
                              ) : null}
                            </View>
                          );
                        })}
                        {filteredBindings.length > visibleBindings.length ? (
                          <Text style={[styles.keybindingMeta, { color: colors.tertiaryLabel }]}>
                            Showing first {visibleBindings.length} matching shortcuts. Use search to
                            narrow the list or desktop for keyboard capture.
                          </Text>
                        ) : null}
                        <Text style={[styles.keybindingMeta, { color: colors.tertiaryLabel }]}>
                          Use values like{" "}
                          {formatShortcutValue(
                            visibleBindings[0]?.shortcut ?? {
                              key: "k",
                              modKey: true,
                              ctrlKey: false,
                              metaKey: false,
                              altKey: false,
                              shiftKey: false,
                            },
                          )}{" "}
                          as `mod+k`, `ctrl+shift+p`, or `alt+arrowleft`.
                        </Text>
                      </View>
                    )}
                    {hostIndex < keybindingsStatuses.length - 1 ? (
                      <View
                        style={[styles.settingsDivider, { backgroundColor: colors.separator }]}
                      />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Providers</SectionTitle>
            <Pressable
              disabled={loadingProviders || connectedConnections.length === 0}
              onPress={() => void loadProviderStatuses(true)}
              style={[
                styles.refreshButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (loadingProviders || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {loadingProviders ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
            </Pressable>
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {providerStatuses.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No provider status
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Connect a host to inspect installed agent providers.
                </Text>
              </View>
            ) : (
              providerStatuses.map((status, hostIndex) => (
                <View key={status.hostId}>
                  <View style={styles.providerHostHeader}>
                    <Text style={[styles.providerHostName, { color: colors.foreground }]}>
                      {status.hostName}
                    </Text>
                    {status.error ? (
                      <StatusBadge label="error" tone="danger" />
                    ) : (
                      <StatusBadge label={`${status.providers.length} providers`} tone="muted" />
                    )}
                  </View>
                  {status.error ? (
                    <Text style={[styles.providerError, { color: colors.red }]}>
                      {status.error}
                    </Text>
                  ) : (
                    status.providers.map((provider, index) => {
                      const ready =
                        provider.enabled &&
                        provider.installed &&
                        provider.status !== "disabled" &&
                        provider.auth.status !== "unauthenticated";
                      return (
                        <View
                          key={`${status.hostId}-${provider.provider}`}
                          style={styles.providerRow}
                        >
                          <View
                            style={[
                              styles.providerIcon,
                              {
                                backgroundColor: ready
                                  ? withAlpha(colors.green, 0.14)
                                  : withAlpha(colors.orange, 0.14),
                              },
                            ]}
                          >
                            <Bot
                              size={15}
                              color={ready ? colors.green : colors.orange}
                              strokeWidth={2.2}
                            />
                          </View>
                          <View style={styles.providerCopy}>
                            <Text
                              style={[styles.providerName, { color: colors.foreground }]}
                              numberOfLines={1}
                            >
                              {PROVIDER_DISPLAY_NAMES[provider.provider as ProviderKind] ??
                                provider.provider}
                            </Text>
                            <Text
                              style={[styles.providerMeta, { color: colors.secondaryLabel }]}
                              numberOfLines={1}
                            >
                              {provider.installed ? "Installed" : "Missing"} ·{" "}
                              {provider.auth.status} · {provider.models.length} models
                            </Text>
                          </View>
                          <StatusBadge
                            label={ready ? "ready" : provider.status}
                            tone={ready ? "success" : "warning"}
                          />
                          {index < status.providers.length - 1 ? (
                            <View
                              style={[
                                styles.providerSeparator,
                                { backgroundColor: colors.separator },
                              ]}
                            />
                          ) : null}
                        </View>
                      );
                    })
                  )}
                  {hostIndex < providerStatuses.length - 1 ? (
                    <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                  ) : null}
                </View>
              ))
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Preferences</SectionTitle>
            <Pressable
              disabled={loadingSettings || connectedConnections.length === 0}
              onPress={() => void loadSettingsStatuses()}
              style={[
                styles.refreshButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (loadingSettings || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {loadingSettings ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
            </Pressable>
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {settingsStatuses.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No host preferences
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Connect a host to tune agent runtime settings from mobile.
                </Text>
              </View>
            ) : (
              settingsStatuses.map((entry, hostIndex) => {
                const settings = entry.settings;
                const updating = updatingSettingsHostId === entry.hostId;
                return (
                  <View key={entry.hostId}>
                    <View style={styles.providerHostHeader}>
                      <Text style={[styles.providerHostName, { color: colors.foreground }]}>
                        {entry.hostName}
                      </Text>
                      {entry.error ? (
                        <StatusBadge label="error" tone="danger" />
                      ) : (
                        <StatusBadge
                          label={settings?.defaultThreadEnvMode ?? "settings"}
                          tone="muted"
                        />
                      )}
                    </View>
                    {entry.error || !settings ? (
                      <Text style={[styles.providerError, { color: colors.red }]}>
                        {entry.error ?? "Settings are unavailable."}
                      </Text>
                    ) : (
                      <View style={styles.settingsBody}>
                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Thread workspace
                        </Text>
                        <View style={styles.settingSegment}>
                          {(["local", "worktree"] as const).map((mode) => {
                            const selected = settings.defaultThreadEnvMode === mode;
                            return (
                              <Pressable
                                key={mode}
                                disabled={updating}
                                onPress={() =>
                                  void updateHostSettings(entry.hostId, {
                                    defaultThreadEnvMode: mode,
                                  })
                                }
                                style={[
                                  styles.settingSegmentButton,
                                  {
                                    backgroundColor: selected
                                      ? withAlpha(colors.primary, 0.12)
                                      : colors.surfaceSecondary,
                                    borderColor: selected
                                      ? withAlpha(colors.primary, 0.34)
                                      : colors.elevatedBorder,
                                  },
                                  updating && styles.disabled,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.settingSegmentLabel,
                                    { color: selected ? colors.primary : colors.secondaryLabel },
                                  ]}
                                >
                                  {mode === "local" ? "Local" : "Worktree"}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Git text model
                        </Text>
                        <View style={styles.providerChoiceGrid}>
                          {SETTINGS_PROVIDER_ORDER.map((provider) => {
                            const selected =
                              settings.textGenerationModelSelection.provider === provider;
                            const modelOptions = providerModelOptions(
                              entry.hostId,
                              provider,
                              providerStatuses,
                              settings,
                            );
                            return (
                              <Pressable
                                key={provider}
                                disabled={updating}
                                onPress={() =>
                                  void updateHostSettings(entry.hostId, {
                                    textGenerationModelSelection: {
                                      provider,
                                      model:
                                        modelOptions[0] ??
                                        DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider],
                                    },
                                  })
                                }
                                style={[
                                  styles.providerChoiceButton,
                                  {
                                    backgroundColor: selected
                                      ? withAlpha(colors.primary, 0.12)
                                      : colors.surfaceSecondary,
                                    borderColor: selected
                                      ? withAlpha(colors.primary, 0.34)
                                      : colors.elevatedBorder,
                                  },
                                  updating && styles.disabled,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.settingSegmentLabel,
                                    { color: selected ? colors.primary : colors.secondaryLabel },
                                  ]}
                                  numberOfLines={1}
                                >
                                  {PROVIDER_DISPLAY_NAMES[provider] ?? provider}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        <View style={styles.modelChoiceWrap}>
                          {providerModelOptions(
                            entry.hostId,
                            settings.textGenerationModelSelection.provider,
                            providerStatuses,
                            settings,
                          )
                            .slice(0, 8)
                            .map((model) => {
                              const selected =
                                settings.textGenerationModelSelection.model === model;
                              return (
                                <Pressable
                                  key={model}
                                  disabled={updating}
                                  onPress={() =>
                                    void updateHostSettings(entry.hostId, {
                                      textGenerationModelSelection: {
                                        provider: settings.textGenerationModelSelection.provider,
                                        model,
                                      },
                                    })
                                  }
                                  style={[
                                    styles.modelChoice,
                                    {
                                      backgroundColor: selected
                                        ? withAlpha(colors.primary, 0.12)
                                        : colors.surfaceSecondary,
                                      borderColor: selected
                                        ? withAlpha(colors.primary, 0.34)
                                        : colors.elevatedBorder,
                                    },
                                    updating && styles.disabled,
                                  ]}
                                >
                                  <Text
                                    style={[
                                      styles.modelChoiceText,
                                      {
                                        color: selected ? colors.primary : colors.secondaryLabel,
                                      },
                                    ]}
                                    numberOfLines={1}
                                  >
                                    {model}
                                  </Text>
                                </Pressable>
                              );
                            })}
                        </View>
                        <TextInput
                          defaultValue={settings.textGenerationModelSelection.model}
                          placeholder="Git text model"
                          placeholderTextColor={colors.muted}
                          autoCapitalize="none"
                          autoCorrect={false}
                          onSubmitEditing={(event) => {
                            const model = event.nativeEvent.text.trim();
                            if (!model) return;
                            void updateHostSettings(entry.hostId, {
                              textGenerationModelSelection: {
                                provider: settings.textGenerationModelSelection.provider,
                                model,
                              },
                            });
                          }}
                          style={[
                            styles.settingTextInput,
                            {
                              color: colors.foreground,
                              backgroundColor: colors.surfaceSecondary,
                              borderColor: colors.elevatedBorder,
                            },
                          ]}
                        />

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Streaming
                        </Text>
                        <View style={styles.settingToggleGrid}>
                          <SettingsToggle
                            label="Assistant"
                            enabled={settings.enableAssistantStreaming}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                enableAssistantStreaming: !settings.enableAssistantStreaming,
                              })
                            }
                          />
                          <SettingsToggle
                            label="Tools"
                            enabled={settings.enableToolStreaming}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                enableToolStreaming: !settings.enableToolStreaming,
                              })
                            }
                          />
                          <SettingsToggle
                            label="Thinking"
                            enabled={settings.enableThinkingStreaming}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                enableThinkingStreaming: !settings.enableThinkingStreaming,
                              })
                            }
                          />
                        </View>

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Notifications
                        </Text>
                        <View style={styles.settingToggleGrid}>
                          <SettingsToggle
                            label="Done"
                            enabled={settings.notifyOnAgentCompletion}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                notifyOnAgentCompletion: !settings.notifyOnAgentCompletion,
                              })
                            }
                          />
                          <SettingsToggle
                            label="Approval"
                            enabled={settings.notifyOnApprovalRequired}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                notifyOnApprovalRequired: !settings.notifyOnApprovalRequired,
                              })
                            }
                          />
                          <SettingsToggle
                            label="Input"
                            enabled={settings.notifyOnUserInputRequired}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                notifyOnUserInputRequired: !settings.notifyOnUserInputRequired,
                              })
                            }
                          />
                        </View>

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Provider CLI pool
                        </Text>
                        <View style={styles.settingStepperRow}>
                          <View style={styles.settingStepperCopy}>
                            <Text
                              style={[styles.settingStepperTitle, { color: colors.foreground }]}
                            >
                              Max open CLIs
                            </Text>
                            <Text
                              style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}
                            >
                              {settings.providerCliMaxOpen} concurrent processes
                            </Text>
                          </View>
                          <View style={styles.settingStepperActions}>
                            <Pressable
                              disabled={updating || settings.providerCliMaxOpen <= 1}
                              onPress={() =>
                                void updateHostSettings(entry.hostId, {
                                  providerCliMaxOpen: Math.max(1, settings.providerCliMaxOpen - 1),
                                })
                              }
                              style={[
                                styles.stepperButton,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                                (updating || settings.providerCliMaxOpen <= 1) && styles.disabled,
                              ]}
                            >
                              <Text
                                style={[styles.stepperButtonText, { color: colors.foreground }]}
                              >
                                -
                              </Text>
                            </Pressable>
                            <Pressable
                              disabled={updating}
                              onPress={() =>
                                void updateHostSettings(entry.hostId, {
                                  providerCliMaxOpen: settings.providerCliMaxOpen + 1,
                                })
                              }
                              style={[
                                styles.stepperButton,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                                updating && styles.disabled,
                              ]}
                            >
                              <Text
                                style={[styles.stepperButtonText, { color: colors.foreground }]}
                              >
                                +
                              </Text>
                            </Pressable>
                          </View>
                        </View>

                        <View style={styles.settingStepperRow}>
                          <View style={styles.settingStepperCopy}>
                            <Text
                              style={[styles.settingStepperTitle, { color: colors.foreground }]}
                            >
                              Idle timeout
                            </Text>
                            <Text
                              style={[styles.settingStepperMeta, { color: colors.secondaryLabel }]}
                            >
                              {Math.round(settings.providerCliIdleTtlSeconds / 60)} minutes before
                              closing idle CLIs
                            </Text>
                          </View>
                          <View style={styles.settingStepperActions}>
                            <Pressable
                              disabled={updating || settings.providerCliIdleTtlSeconds <= 60}
                              onPress={() =>
                                void updateHostSettings(entry.hostId, {
                                  providerCliIdleTtlSeconds: Math.max(
                                    60,
                                    settings.providerCliIdleTtlSeconds - 60,
                                  ),
                                })
                              }
                              style={[
                                styles.stepperButton,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                                (updating || settings.providerCliIdleTtlSeconds <= 60) &&
                                  styles.disabled,
                              ]}
                            >
                              <Text
                                style={[styles.stepperButtonText, { color: colors.foreground }]}
                              >
                                -
                              </Text>
                            </Pressable>
                            <Pressable
                              disabled={updating}
                              onPress={() =>
                                void updateHostSettings(entry.hostId, {
                                  providerCliIdleTtlSeconds:
                                    settings.providerCliIdleTtlSeconds + 60,
                                })
                              }
                              style={[
                                styles.stepperButton,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                                updating && styles.disabled,
                              ]}
                            >
                              <Text
                                style={[styles.stepperButtonText, { color: colors.foreground }]}
                              >
                                +
                              </Text>
                            </Pressable>
                          </View>
                        </View>

                        <View style={styles.settingTextFieldRow}>
                          <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
                            Add-project base directory
                          </Text>
                          <TextInput
                            defaultValue={settings.addProjectBaseDirectory}
                            placeholder="/workspace"
                            placeholderTextColor={colors.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            onSubmitEditing={(event) =>
                              void updateHostSettings(entry.hostId, {
                                addProjectBaseDirectory: event.nativeEvent.text,
                              })
                            }
                            style={[
                              styles.settingTextInput,
                              {
                                color: colors.foreground,
                                backgroundColor: colors.surfaceSecondary,
                                borderColor: colors.elevatedBorder,
                              },
                            ]}
                          />
                        </View>

                        <View style={styles.settingTextFieldRow}>
                          <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
                            Git SSH key passphrase
                          </Text>
                          <TextInput
                            defaultValue={settings.gitSshKeyPassphrase}
                            placeholder="Optional passphrase"
                            placeholderTextColor={colors.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            secureTextEntry
                            onSubmitEditing={(event) =>
                              void updateHostSettings(entry.hostId, {
                                gitSshKeyPassphrase: event.nativeEvent.text,
                              })
                            }
                            style={[
                              styles.settingTextInput,
                              {
                                color: colors.foreground,
                                backgroundColor: colors.surfaceSecondary,
                                borderColor: colors.elevatedBorder,
                              },
                            ]}
                          />
                        </View>

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Relay
                        </Text>
                        <View style={styles.settingToggleGrid}>
                          <SettingsToggle
                            label="Managed relay"
                            enabled={settings.remoteRelay.enabled}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                remoteRelay: { enabled: !settings.remoteRelay.enabled },
                              })
                            }
                          />
                          <SettingsToggle
                            label="Local insecure"
                            enabled={settings.remoteRelay.allowInsecureLocalUrls}
                            disabled={updating}
                            onPress={() =>
                              void updateHostSettings(entry.hostId, {
                                remoteRelay: {
                                  allowInsecureLocalUrls:
                                    !settings.remoteRelay.allowInsecureLocalUrls,
                                },
                              })
                            }
                          />
                        </View>
                        <View style={styles.settingTextFieldRow}>
                          <Text style={[styles.settingStepperTitle, { color: colors.foreground }]}>
                            Relay URL
                          </Text>
                          <TextInput
                            defaultValue={settings.remoteRelay.defaultUrl}
                            placeholder="wss://relay.example.com/v1/ws"
                            placeholderTextColor={colors.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            onSubmitEditing={(event) =>
                              void updateHostSettings(entry.hostId, {
                                remoteRelay: { defaultUrl: event.nativeEvent.text },
                              })
                            }
                            style={[
                              styles.settingTextInput,
                              {
                                color: colors.foreground,
                                backgroundColor: colors.surfaceSecondary,
                                borderColor: colors.elevatedBorder,
                              },
                            ]}
                          />
                        </View>

                        <Text style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}>
                          Provider configuration
                        </Text>
                        <View style={styles.providerSettingsStack}>
                          {SETTINGS_PROVIDER_ORDER.map((provider) => {
                            const providerConfig = settings.providers[provider];
                            const providerLabel = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
                            const openCodeQuery = openCodeModelQueryByHostId[entry.hostId] ?? "";
                            const openCodeResults =
                              openCodeModelResultsByHostId[entry.hostId] ?? [];
                            const searchingOpenCode = searchingOpenCodeModelHostId === entry.hostId;
                            return (
                              <View
                                key={provider}
                                style={[
                                  styles.providerSettingsCard,
                                  {
                                    backgroundColor: colors.surfaceSecondary,
                                    borderColor: colors.elevatedBorder,
                                  },
                                ]}
                              >
                                <View style={styles.providerSettingsHeader}>
                                  <View style={styles.providerSettingsCopy}>
                                    <Text
                                      style={[styles.providerName, { color: colors.foreground }]}
                                      numberOfLines={1}
                                    >
                                      {providerLabel}
                                    </Text>
                                    <Text
                                      style={[
                                        styles.providerMeta,
                                        { color: colors.secondaryLabel },
                                      ]}
                                      numberOfLines={1}
                                    >
                                      {providerConfig.binaryPath.trim() || "Default binary"}
                                    </Text>
                                  </View>
                                  <SettingsToggle
                                    label={providerConfig.enabled ? "On" : "Off"}
                                    enabled={providerConfig.enabled}
                                    disabled={updating}
                                    onPress={() =>
                                      void updateHostSettings(
                                        entry.hostId,
                                        providerSettingsPatch(provider, {
                                          enabled: !providerConfig.enabled,
                                        }),
                                      )
                                    }
                                  />
                                </View>
                                <TextInput
                                  defaultValue={providerConfig.binaryPath}
                                  placeholder="Binary path"
                                  placeholderTextColor={colors.muted}
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                  onSubmitEditing={(event) =>
                                    void updateHostSettings(
                                      entry.hostId,
                                      providerSettingsPatch(provider, {
                                        binaryPath: event.nativeEvent.text,
                                      }),
                                    )
                                  }
                                  style={[
                                    styles.settingTextInput,
                                    {
                                      color: colors.foreground,
                                      backgroundColor: colors.background,
                                      borderColor: colors.elevatedBorder,
                                    },
                                  ]}
                                />
                                {provider === "codex" ? (
                                  <TextInput
                                    defaultValue={settings.providers.codex.homePath}
                                    placeholder="Codex home path"
                                    placeholderTextColor={colors.muted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    onSubmitEditing={(event) =>
                                      void updateHostSettings(entry.hostId, {
                                        providers: {
                                          codex: { homePath: event.nativeEvent.text },
                                        },
                                      })
                                    }
                                    style={[
                                      styles.settingTextInput,
                                      {
                                        color: colors.foreground,
                                        backgroundColor: colors.background,
                                        borderColor: colors.elevatedBorder,
                                      },
                                    ]}
                                  />
                                ) : null}
                                {provider === "githubCopilot" ? (
                                  <TextInput
                                    defaultValue={settings.providers.githubCopilot.cliUrl}
                                    placeholder="GitHub Copilot CLI URL"
                                    placeholderTextColor={colors.muted}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    onSubmitEditing={(event) =>
                                      void updateHostSettings(entry.hostId, {
                                        providers: {
                                          githubCopilot: { cliUrl: event.nativeEvent.text },
                                        },
                                      })
                                    }
                                    style={[
                                      styles.settingTextInput,
                                      {
                                        color: colors.foreground,
                                        backgroundColor: colors.background,
                                        borderColor: colors.elevatedBorder,
                                      },
                                    ]}
                                  />
                                ) : null}
                                {provider === "opencode" ? (
                                  <View style={styles.providerDiscoveryPanel}>
                                    <Text
                                      style={[
                                        styles.settingsGroupLabel,
                                        { color: colors.tertiaryLabel },
                                      ]}
                                    >
                                      Model discovery
                                    </Text>
                                    <View style={styles.marketplaceSearchRow}>
                                      <TextInput
                                        value={openCodeQuery}
                                        onChangeText={(value) =>
                                          setOpenCodeModelQueryByHostId((current) => ({
                                            ...current,
                                            [entry.hostId]: value,
                                          }))
                                        }
                                        placeholder="openai/gpt-4.1"
                                        placeholderTextColor={colors.muted}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        onSubmitEditing={() =>
                                          void searchOpenCodeModels(entry.hostId)
                                        }
                                        style={[
                                          styles.marketplaceSearchInput,
                                          {
                                            color: colors.foreground,
                                            backgroundColor: colors.background,
                                            borderColor: colors.elevatedBorder,
                                          },
                                        ]}
                                      />
                                      <Pressable
                                        disabled={searchingOpenCode || openCodeQuery.trim() === ""}
                                        onPress={() => void searchOpenCodeModels(entry.hostId)}
                                        style={[
                                          styles.marketplaceSearchButton,
                                          {
                                            backgroundColor: colors.background,
                                            borderColor: colors.elevatedBorder,
                                          },
                                          (searchingOpenCode || openCodeQuery.trim() === "") &&
                                            styles.disabled,
                                        ]}
                                      >
                                        {searchingOpenCode ? (
                                          <ActivityIndicator color={colors.primary} />
                                        ) : (
                                          <Text
                                            style={[
                                              styles.marketplaceSearchText,
                                              { color: colors.foreground },
                                            ]}
                                          >
                                            Search
                                          </Text>
                                        )}
                                      </Pressable>
                                    </View>
                                    {openCodeResults.length > 0 ? (
                                      <View style={styles.marketplaceResults}>
                                        {openCodeResults.map((model) => {
                                          const saved = providerConfig.customModels.includes(
                                            model.slug,
                                          );
                                          return (
                                            <View
                                              key={model.slug}
                                              style={[
                                                styles.marketplaceRow,
                                                {
                                                  backgroundColor: colors.background,
                                                  borderColor: colors.elevatedBorder,
                                                },
                                              ]}
                                            >
                                              <View style={styles.marketplaceCopy}>
                                                <Text
                                                  style={[
                                                    styles.providerName,
                                                    { color: colors.foreground },
                                                  ]}
                                                  numberOfLines={1}
                                                >
                                                  {model.name}
                                                </Text>
                                                <Text
                                                  style={[
                                                    styles.providerMeta,
                                                    { color: colors.secondaryLabel },
                                                  ]}
                                                  numberOfLines={1}
                                                >
                                                  {model.slug}
                                                </Text>
                                              </View>
                                              <Pressable
                                                disabled={saved || updating}
                                                onPress={() =>
                                                  void addOpenCodeModel(
                                                    entry.hostId,
                                                    settings,
                                                    model.slug,
                                                  )
                                                }
                                                style={[
                                                  styles.marketplaceInstallButton,
                                                  {
                                                    backgroundColor: saved
                                                      ? colors.surfaceSecondary
                                                      : colors.primary,
                                                  },
                                                  (saved || updating) && styles.disabled,
                                                ]}
                                              >
                                                <Text
                                                  style={[
                                                    styles.marketplaceInstallText,
                                                    {
                                                      color: saved
                                                        ? colors.secondaryLabel
                                                        : colors.primaryForeground,
                                                    },
                                                  ]}
                                                >
                                                  {saved ? "Saved" : "Add"}
                                                </Text>
                                              </Pressable>
                                            </View>
                                          );
                                        })}
                                      </View>
                                    ) : null}
                                  </View>
                                ) : null}
                                <TextInput
                                  key={`${provider}:${customModelInputValue(providerConfig.customModels)}`}
                                  defaultValue={customModelInputValue(providerConfig.customModels)}
                                  placeholder="Custom models, comma separated"
                                  placeholderTextColor={colors.muted}
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                  multiline
                                  onSubmitEditing={(event) =>
                                    void updateHostSettings(
                                      entry.hostId,
                                      providerSettingsPatch(provider, {
                                        customModels: parseCustomModelInput(event.nativeEvent.text),
                                      }),
                                    )
                                  }
                                  onEndEditing={(event) =>
                                    void updateHostSettings(
                                      entry.hostId,
                                      providerSettingsPatch(provider, {
                                        customModels: parseCustomModelInput(event.nativeEvent.text),
                                      }),
                                    )
                                  }
                                  style={[
                                    styles.settingTextInput,
                                    styles.providerModelsInput,
                                    {
                                      color: colors.foreground,
                                      backgroundColor: colors.background,
                                      borderColor: colors.elevatedBorder,
                                    },
                                  ]}
                                />
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    )}
                    {hostIndex < settingsStatuses.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Tooling</SectionTitle>
            <Pressable
              disabled={loadingLspTools || connectedConnections.length === 0}
              onPress={() => void loadLspStatuses()}
              style={[
                styles.refreshButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (loadingLspTools || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {loadingLspTools ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
            </Pressable>
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {lspStatuses.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No tooling status
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Connect a host to inspect language server tools used by agent workspaces.
                </Text>
              </View>
            ) : (
              lspStatuses.map((entry, hostIndex) => {
                const installedCount =
                  entry.status?.tools.filter((tool) => tool.installed).length ?? 0;
                const totalCount = entry.status?.tools.length ?? 0;
                const missingCount = Math.max(totalCount - installedCount, 0);
                const isInstalling = installingLspHostId === entry.hostId;
                const visibleTools = entry.status?.tools.slice(0, 6) ?? [];
                const marketplaceQuery = lspSearchQueryByHostId[entry.hostId] ?? "";
                const marketplaceResults = lspSearchResultsByHostId[entry.hostId] ?? [];
                const isSearchingMarketplace = searchingLspHostId === entry.hostId;

                return (
                  <View key={entry.hostId}>
                    <View style={styles.toolHostHeader}>
                      <View style={styles.toolHostCopy}>
                        <Text style={[styles.providerHostName, { color: colors.foreground }]}>
                          {entry.hostName}
                        </Text>
                        {entry.status ? (
                          <Text
                            style={[styles.toolInstallDir, { color: colors.secondaryLabel }]}
                            numberOfLines={1}
                          >
                            {entry.status.installDir}
                          </Text>
                        ) : null}
                      </View>
                      {entry.error ? (
                        <StatusBadge label="error" tone="danger" />
                      ) : (
                        <StatusBadge
                          label={`${installedCount}/${totalCount} installed`}
                          tone={missingCount === 0 ? "success" : "warning"}
                        />
                      )}
                    </View>
                    {entry.error ? (
                      <Text style={[styles.providerError, { color: colors.red }]}>
                        {entry.error}
                      </Text>
                    ) : (
                      <>
                        {visibleTools.map((tool, index) => (
                          <View key={`${entry.hostId}-${tool.id}`} style={styles.providerRow}>
                            <View
                              style={[
                                styles.providerIcon,
                                {
                                  backgroundColor: tool.installed
                                    ? withAlpha(colors.green, 0.14)
                                    : withAlpha(colors.orange, 0.14),
                                },
                              ]}
                            >
                              <Wrench
                                size={15}
                                color={tool.installed ? colors.green : colors.orange}
                                strokeWidth={2.2}
                              />
                            </View>
                            <View style={styles.providerCopy}>
                              <Text
                                style={[styles.providerName, { color: colors.foreground }]}
                                numberOfLines={1}
                              >
                                {tool.label}
                              </Text>
                              <Text
                                style={[styles.providerMeta, { color: colors.secondaryLabel }]}
                                numberOfLines={1}
                              >
                                {tool.category} ·{" "}
                                {tool.installed ? (tool.version ?? "installed") : "missing"}
                              </Text>
                            </View>
                            <StatusBadge
                              label={tool.installed ? "ready" : "missing"}
                              tone={tool.installed ? "success" : "warning"}
                            />
                            {index < visibleTools.length - 1 ? (
                              <View
                                style={[
                                  styles.providerSeparator,
                                  { backgroundColor: colors.separator },
                                ]}
                              />
                            ) : null}
                          </View>
                        ))}
                        <View style={styles.toolActions}>
                          <Pressable
                            disabled={isInstalling || totalCount === 0 || missingCount === 0}
                            onPress={() => void installLspTools(entry.hostId)}
                            style={[
                              styles.installButton,
                              {
                                backgroundColor: withAlpha(colors.primary, 0.12),
                                borderColor: withAlpha(colors.primary, 0.2),
                              },
                              (isInstalling || totalCount === 0 || missingCount === 0) &&
                                styles.disabled,
                            ]}
                          >
                            {isInstalling ? (
                              <ActivityIndicator color={colors.primary} />
                            ) : (
                              <Wrench size={15} color={colors.primary} strokeWidth={2.2} />
                            )}
                            <Text style={[styles.installButtonText, { color: colors.primary }]}>
                              {missingCount === 0
                                ? "All installed"
                                : `Install ${missingCount} missing`}
                            </Text>
                          </Pressable>
                          {totalCount > visibleTools.length ? (
                            <Text style={[styles.toolMoreText, { color: colors.secondaryLabel }]}>
                              +{totalCount - visibleTools.length} more tools
                            </Text>
                          ) : null}
                        </View>
                        <View style={styles.marketplacePanel}>
                          <Text
                            style={[styles.settingsGroupLabel, { color: colors.tertiaryLabel }]}
                          >
                            Marketplace
                          </Text>
                          <View style={styles.marketplaceSearchRow}>
                            <TextInput
                              value={marketplaceQuery}
                              onChangeText={(value) =>
                                setLspSearchQueryByHostId((current) => ({
                                  ...current,
                                  [entry.hostId]: value,
                                }))
                              }
                              placeholder="typescript-language-server"
                              placeholderTextColor={colors.muted}
                              autoCapitalize="none"
                              autoCorrect={false}
                              onSubmitEditing={() => void searchLspMarketplace(entry.hostId)}
                              style={[
                                styles.marketplaceSearchInput,
                                {
                                  color: colors.foreground,
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                              ]}
                            />
                            <Pressable
                              disabled={
                                isSearchingMarketplace || marketplaceQuery.trim().length === 0
                              }
                              onPress={() => void searchLspMarketplace(entry.hostId)}
                              style={[
                                styles.marketplaceSearchButton,
                                {
                                  backgroundColor: colors.surfaceSecondary,
                                  borderColor: colors.elevatedBorder,
                                },
                                (isSearchingMarketplace || marketplaceQuery.trim().length === 0) &&
                                  styles.disabled,
                              ]}
                            >
                              {isSearchingMarketplace ? (
                                <ActivityIndicator color={colors.primary} />
                              ) : (
                                <Text
                                  style={[
                                    styles.marketplaceSearchText,
                                    { color: colors.foreground },
                                  ]}
                                >
                                  Search
                                </Text>
                              )}
                            </Pressable>
                          </View>
                          {marketplaceResults.length > 0 ? (
                            <View style={styles.marketplaceResults}>
                              {marketplaceResults.map((pkg) => {
                                const installId = `${entry.hostId}:${pkg.packageName}`;
                                const installing = installingLspPackageId === installId;
                                return (
                                  <View
                                    key={pkg.packageName}
                                    style={[
                                      styles.marketplaceRow,
                                      {
                                        backgroundColor: colors.surfaceSecondary,
                                        borderColor: colors.elevatedBorder,
                                      },
                                    ]}
                                  >
                                    <View style={styles.marketplaceCopy}>
                                      <Text
                                        style={[styles.providerName, { color: colors.foreground }]}
                                        numberOfLines={1}
                                      >
                                        {pkg.packageName}
                                      </Text>
                                      <Text
                                        style={[
                                          styles.providerMeta,
                                          { color: colors.secondaryLabel },
                                        ]}
                                        numberOfLines={2}
                                      >
                                        {pkg.description ?? "No package description"} ·{" "}
                                        {pkg.version ?? "latest"}
                                      </Text>
                                    </View>
                                    <Pressable
                                      disabled={installing || installingLspPackageId !== null}
                                      onPress={() =>
                                        void installMarketplaceLspPackage(entry.hostId, pkg)
                                      }
                                      style={[
                                        styles.marketplaceInstallButton,
                                        { backgroundColor: colors.primary },
                                        (installing || installingLspPackageId !== null) &&
                                          styles.disabled,
                                      ]}
                                    >
                                      {installing ? (
                                        <ActivityIndicator color={colors.primaryForeground} />
                                      ) : (
                                        <Text
                                          style={[
                                            styles.marketplaceInstallText,
                                            { color: colors.primaryForeground },
                                          ]}
                                        >
                                          Install
                                        </Text>
                                      )}
                                    </Pressable>
                                  </View>
                                );
                              })}
                            </View>
                          ) : null}
                        </View>
                      </>
                    )}
                    {hostIndex < lspStatuses.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Archived</SectionTitle>
            <Pressable
              disabled={loadingArchived || connectedConnections.length === 0}
              onPress={() => void loadArchivedStatuses()}
              style={[
                styles.refreshButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (loadingArchived || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {loadingArchived ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
            </Pressable>
          </View>
          <Panel padded={false} style={styles.panelShell}>
            {archivedStatuses.length === 0 ? (
              <View style={styles.emptyHosts}>
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                  No archive status
                </Text>
                <Text style={[styles.emptyBody, { color: colors.secondaryLabel }]}>
                  Connect a host to restore archived projects and threads.
                </Text>
              </View>
            ) : (
              archivedStatuses.map((status, hostIndex) => {
                const itemCount = status.projects.length + status.threads.length;
                return (
                  <View key={status.hostId}>
                    <View style={styles.providerHostHeader}>
                      <Text style={[styles.providerHostName, { color: colors.foreground }]}>
                        {status.hostName}
                      </Text>
                      {status.error ? (
                        <StatusBadge label="error" tone="danger" />
                      ) : (
                        <StatusBadge label={`${itemCount} archived`} tone="muted" />
                      )}
                    </View>
                    {status.error ? (
                      <Text style={[styles.providerError, { color: colors.red }]}>
                        {status.error}
                      </Text>
                    ) : itemCount === 0 ? (
                      <Text style={[styles.archiveEmptyText, { color: colors.secondaryLabel }]}>
                        No archived items on this host.
                      </Text>
                    ) : (
                      <>
                        {status.projects.map((project) => {
                          const restoreId = `project:${status.hostId}:${project.id}`;
                          return (
                            <ArchivedRow
                              key={restoreId}
                              title={project.title}
                              meta={`Project · ${project.workspaceRoot}`}
                              restoring={restoringArchivedId === restoreId}
                              onRestore={() =>
                                void restoreArchivedProject(status.hostId, project.id)
                              }
                            />
                          );
                        })}
                        {status.threads.map((thread) => {
                          const restoreId = `thread:${status.hostId}:${thread.id}`;
                          return (
                            <ArchivedRow
                              key={restoreId}
                              title={thread.title}
                              meta="Thread"
                              restoring={restoringArchivedId === restoreId}
                              onRestore={() => void restoreArchivedThread(status.hostId, thread.id)}
                            />
                          );
                        })}
                      </>
                    )}
                    {hostIndex < archivedStatuses.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </View>
                );
              })
            )}
          </Panel>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <SectionTitle>Diagnostics</SectionTitle>
            <Pressable
              disabled={runningDiagnostics || connectedConnections.length === 0}
              onPress={() => void runDiagnostics()}
              style={[
                styles.diagnosticsButton,
                {
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
                (runningDiagnostics || connectedConnections.length === 0) && styles.disabled,
              ]}
            >
              {runningDiagnostics ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
              )}
              <Text style={[styles.diagnosticsButtonText, { color: colors.foreground }]}>
                Check
              </Text>
            </Pressable>
          </View>
          <Panel style={styles.diagnosticsPanel}>
            <Text style={[styles.diagnosticsBody, { color: colors.secondaryLabel }]}>
              Run a host smoke check for server config, orchestration snapshots, workspace writes,
              git status, terminal sessions, settings, and tooling RPCs.
            </Text>
            {connectedConnections.length === 0 ? (
              <Text style={[styles.diagnosticsBody, { color: colors.tertiaryLabel }]}>
                Connect a host before running diagnostics.
              </Text>
            ) : null}
            {diagnosticsStatuses.length > 0 ? (
              <View style={styles.diagnosticsList}>
                {diagnosticsStatuses.map((status) => (
                  <View
                    key={status.hostId}
                    style={[
                      styles.diagnosticsRow,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <View style={styles.diagnosticsCopy}>
                      <Text
                        style={[styles.diagnosticsHostName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {status.hostName}
                      </Text>
                      <Text
                        style={[
                          styles.diagnosticsMeta,
                          { color: status.error ? colors.red : colors.secondaryLabel },
                        ]}
                        numberOfLines={2}
                      >
                        {status.error ?? status.checks.join(" · ")}
                      </Text>
                    </View>
                    <StatusBadge
                      label={status.error ? "fail" : "ok"}
                      tone={status.error ? "danger" : "success"}
                    />
                  </View>
                ))}
              </View>
            ) : null}
            <View style={[styles.diagnosticsDivider, { backgroundColor: colors.separator }]} />
            <View style={styles.nativePermissionHeader}>
              <View style={styles.diagnosticsCopy}>
                <Text style={[styles.diagnosticsHostName, { color: colors.foreground }]}>
                  Native permissions
                </Text>
                <Text style={[styles.diagnosticsMeta, { color: colors.secondaryLabel }]}>
                  Check notification, camera, and photo-library access without prompting.
                </Text>
              </View>
              <Pressable
                disabled={checkingNativePermissions}
                onPress={() => void checkNativePermissions()}
                style={[
                  styles.permissionCheckButton,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                  checkingNativePermissions && styles.disabled,
                ]}
              >
                {checkingNativePermissions ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Text style={[styles.diagnosticsButtonText, { color: colors.foreground }]}>
                    Refresh
                  </Text>
                )}
              </Pressable>
            </View>
            {nativePermissionStatuses.length > 0 ? (
              <View style={styles.diagnosticsList}>
                {nativePermissionStatuses.map((status) => (
                  <View
                    key={status.kind}
                    style={[
                      styles.diagnosticsRow,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <View style={styles.diagnosticsCopy}>
                      <Text
                        style={[styles.diagnosticsHostName, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {status.label}
                      </Text>
                      <Text
                        style={[
                          styles.diagnosticsMeta,
                          {
                            color:
                              status.state === "blocked"
                                ? colors.red
                                : status.state === "granted"
                                  ? colors.secondaryLabel
                                  : colors.orange,
                          },
                        ]}
                        numberOfLines={2}
                      >
                        {status.detail}
                      </Text>
                    </View>
                    <View style={styles.permissionActions}>
                      {status.state === "not-granted" ? (
                        <Pressable
                          disabled={requestingNativePermission !== null}
                          onPress={() => void requestNativePermission(status.kind)}
                          style={[
                            styles.permissionRequestButton,
                            {
                              backgroundColor: withAlpha(colors.primary, 0.12),
                              borderColor: withAlpha(colors.primary, 0.24),
                            },
                            requestingNativePermission !== null && styles.disabled,
                          ]}
                        >
                          {requestingNativePermission === status.kind ? (
                            <ActivityIndicator color={colors.primary} />
                          ) : (
                            <Text style={[styles.permissionRequestText, { color: colors.primary }]}>
                              Request
                            </Text>
                          )}
                        </Pressable>
                      ) : null}
                      <StatusBadge
                        label={
                          status.state === "granted"
                            ? "ok"
                            : status.state === "blocked"
                              ? "blocked"
                              : "check"
                        }
                        tone={
                          status.state === "granted"
                            ? "success"
                            : status.state === "blocked"
                              ? "danger"
                              : "warning"
                        }
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
            {nativePermissionStatuses.some((status) => status.state === "blocked") ? (
              <Pressable
                onPress={() => void Linking.openSettings()}
                style={[
                  styles.openSettingsButton,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.12),
                    borderColor: withAlpha(colors.primary, 0.24),
                  },
                ]}
              >
                <Text style={[styles.openSettingsText, { color: colors.primary }]}>
                  Open System Settings
                </Text>
              </Pressable>
            ) : null}
          </Panel>
        </View>

        <View style={styles.section}>
          <SectionTitle>System</SectionTitle>
          <Panel style={styles.aboutPanel}>
            <View style={styles.aboutRow}>
              <View>
                <Text style={[styles.aboutLabel, { color: colors.secondaryLabel }]}>App</Text>
                <Text style={[styles.aboutValue, { color: colors.foreground }]}>
                  ace Mobile v{MOBILE_APP_VERSION}
                </Text>
              </View>
              <View
                style={[
                  styles.aboutBadge,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.14),
                  },
                ]}
              >
                <SlidersHorizontal size={15} color={colors.primary} strokeWidth={2.2} />
              </View>
            </View>
            <Text style={[styles.aboutBody, { color: colors.secondaryLabel }]}>
              Pairing, preferences, and host routing are managed locally on this device.
            </Text>
          </Panel>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  disabled: {
    opacity: 0.58,
  },
  refreshButton: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  panelShell: {
    overflow: "hidden",
  },
  emptyHosts: {
    padding: 20,
  },
  emptyTitle: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  emptyBody: {
    marginTop: 8,
    fontSize: 14,
    lineHeight: 21,
  },
  separator: {
    marginLeft: 18,
    marginRight: 18,
    height: StyleSheet.hairlineWidth,
  },
  themeRow: {
    minHeight: 78,
    paddingHorizontal: 18,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  themeIcon: {
    width: 40,
    height: 40,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  themeCopy: {
    flex: 1,
  },
  themeTitle: {
    fontSize: 17,
    lineHeight: 20,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  themeMeta: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 18,
  },
  providerHostHeader: {
    minHeight: 54,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  providerHostName: {
    flex: 1,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "800",
    letterSpacing: -0.25,
  },
  providerError: {
    paddingHorizontal: 18,
    paddingBottom: 16,
    fontSize: 13,
    lineHeight: 18,
  },
  providerRow: {
    minHeight: 68,
    paddingHorizontal: 18,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  providerIcon: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  providerCopy: {
    flex: 1,
    minWidth: 0,
  },
  providerName: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "800",
    letterSpacing: -0.18,
  },
  providerMeta: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  providerSeparator: {
    position: "absolute",
    bottom: 0,
    left: 66,
    right: 18,
    height: StyleSheet.hairlineWidth,
  },
  archiveEmptyText: {
    paddingHorizontal: 18,
    paddingBottom: 16,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "600",
  },
  archiveRow: {
    minHeight: 66,
    paddingHorizontal: 18,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  archiveIcon: {
    width: 36,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  archiveCopy: {
    flex: 1,
    minWidth: 0,
  },
  browserPanel: {
    gap: 10,
  },
  browserEngineGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  browserEngineButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  browserDataRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  browserDataCopy: {
    flex: 1,
    minWidth: 0,
  },
  clearHistoryButton: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  clearHistoryButtonText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
  },
  restoreButton: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  restoreButtonText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  settingsBody: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 12,
  },
  settingsHostBlock: {
    paddingTop: 16,
  },
  settingsHostHeader: {
    minHeight: 50,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  settingsHostName: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "800",
  },
  settingsHostMeta: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  settingsDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 18,
  },
  settingsGroupLabel: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  settingSegment: {
    flexDirection: "row",
    gap: 10,
  },
  settingSegmentButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  settingSegmentLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  modelChoiceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  providerChoiceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  providerChoiceButton: {
    minHeight: 38,
    maxWidth: "100%",
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modelChoice: {
    maxWidth: "100%",
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  modelChoiceText: {
    maxWidth: 230,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  settingToggleGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  settingToggle: {
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  settingToggleText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  settingStepperRow: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  settingStepperCopy: {
    flex: 1,
    minWidth: 0,
  },
  settingStepperTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  settingStepperMeta: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  settingStepperActions: {
    flexDirection: "row",
    gap: 8,
  },
  stepperButton: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperButtonText: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: "900",
  },
  settingTextFieldRow: {
    gap: 8,
  },
  settingTextInput: {
    minHeight: 46,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  providerSettingsStack: {
    gap: 10,
  },
  providerSettingsCard: {
    borderRadius: Radius.card,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  providerSettingsHeader: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  providerSettingsCopy: {
    flex: 1,
    minWidth: 0,
  },
  providerModelsInput: {
    minHeight: 72,
    paddingTop: 12,
    textAlignVertical: "top",
  },
  providerDiscoveryPanel: {
    gap: 10,
  },
  toolHostHeader: {
    minHeight: 66,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  toolHostCopy: {
    flex: 1,
    minWidth: 0,
  },
  toolInstallDir: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  toolActions: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 10,
  },
  installButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  installButtonText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  toolMoreText: {
    textAlign: "center",
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  marketplacePanel: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 10,
  },
  marketplaceSearchRow: {
    flexDirection: "row",
    gap: 10,
  },
  marketplaceSearchInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  marketplaceSearchButton: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  marketplaceSearchText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  marketplaceResults: {
    gap: 9,
  },
  marketplaceRow: {
    minHeight: 72,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  marketplaceCopy: {
    flex: 1,
    minWidth: 0,
  },
  marketplaceInstallButton: {
    minWidth: 72,
    minHeight: 38,
    borderRadius: Radius.input,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  marketplaceInstallText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "900",
  },
  keybindingList: {
    paddingHorizontal: 18,
    paddingBottom: 18,
    gap: 10,
  },
  keybindingSearchInput: {
    minHeight: 44,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  keybindingCount: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  keybindingRow: {
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  keybindingCopy: {
    minWidth: 0,
  },
  keybindingTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  keybindingMeta: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  keybindingEditor: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  keybindingInput: {
    flex: 1,
    minHeight: 40,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 11,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "800",
  },
  keybindingSaveButton: {
    minWidth: 68,
    minHeight: 40,
    borderRadius: Radius.input,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  keybindingSaveLabel: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "900",
  },
  errorText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
  },
  diagnosticsButton: {
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  diagnosticsButtonText: {
    fontSize: 12,
    fontWeight: "900",
  },
  diagnosticsPanel: {
    gap: 12,
  },
  diagnosticsBody: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  diagnosticsList: {
    gap: 8,
  },
  diagnosticsDivider: {
    height: StyleSheet.hairlineWidth,
  },
  nativePermissionHeader: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  permissionCheckButton: {
    minHeight: 38,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionActions: {
    alignItems: "flex-end",
    gap: 8,
  },
  permissionRequestButton: {
    minHeight: 34,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionRequestText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "900",
  },
  diagnosticsRow: {
    minHeight: 58,
    borderRadius: Radius.input,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  diagnosticsCopy: {
    flex: 1,
    minWidth: 0,
  },
  diagnosticsHostName: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  diagnosticsMeta: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  openSettingsButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  openSettingsText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "900",
  },
  aboutPanel: {
    gap: 14,
  },
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  aboutLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  aboutValue: {
    marginTop: 8,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  aboutBody: {
    fontSize: 14,
    lineHeight: 21,
  },
  aboutBadge: {
    width: 42,
    height: 42,
    borderRadius: Radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
});
