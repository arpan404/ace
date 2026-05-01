import { ArchiveIcon, ArchiveX, ChevronDownIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DesktopCliInstallState,
  type ProviderKind,
  type ServerInstallLspToolInput,
  type ServerLspToolInstaller,
  type ServerLspToolStatus,
  type ServerLspToolsStatus,
  ThreadId,
} from "@ace/contracts";
import {
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE_SCALE,
  DEFAULT_UI_LETTER_SPACING,
  DEFAULT_UI_MONO_FONT_FAMILY,
  DEFAULT_UNIFIED_SETTINGS,
  type UiFontFamily,
  type UiFontSizeScale,
  type UiLetterSpacing,
  type UiMonoFontFamily,
} from "@ace/contracts/settings";
import {
  buildProviderModelSelection,
  formatProviderModelDisplayName,
  normalizeModelSlug,
} from "@ace/shared/model";
import { Equal } from "effect";
import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../lib/desktopUpdate";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { resetThemePresetToDefault, useAppearancePrefs } from "../../appearancePrefs";
import { DEFAULT_THEME_PRESET } from "../../themePresets";
import { ThemePresetPicker } from "./ThemePresetPicker";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  setDesktopCliInstallStateQueryData,
  useDesktopCliInstallState,
} from "../../lib/desktopCliInstallReactQuery";
import {
  MAX_CUSTOM_MODEL_LENGTH,
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BROWSER_SEARCH_ENGINE_OPTIONS } from "../../lib/browser/types";
import { cn, newCommandId } from "../../lib/utils";
import {
  readAgentAttentionNotificationPermission,
  requestAgentAttentionNotificationPermission,
  type AgentAttentionNotificationPermission,
} from "../../lib/agentAttentionNotifications";
import {
  buildAgentAttentionNotificationSettingsPatch,
  buildScopedAgentAttentionNotificationSettingsPatch,
  resolveNotificationToggleChangeIntent,
  type AgentAttentionNotificationSettingKey,
} from "../../lib/notificationSettings";
import { showBrowserNotification } from "../../lib/browserNotifications";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectAvatar } from "../ProjectAvatar";
import type { Project, Thread } from "../../types";
import { ProviderSettingsSection, type ProviderCard } from "./ProviderSettingsSection";
import { KeybindingsSettingsEditor } from "./KeybindingsSettingsEditor";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
  getProviderSummary,
  getProviderVersionLabel,
} from "./SettingsPanelPrimitives";
import { useServerProviders } from "../../rpc/serverState";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const UI_FONT_FAMILY_OPTIONS: { value: UiFontFamily; label: string }[] = [
  { value: "plus-jakarta", label: "Plus Jakarta Sans" },
  { value: "inter", label: "Inter" },
  { value: "system-ui", label: "System UI" },
  { value: "dm-sans", label: "DM Sans" },
  { value: "source-sans-3", label: "Source Sans 3" },
];

const UI_MONO_FONT_OPTIONS: { value: UiMonoFontFamily; label: string }[] = [
  { value: "jetbrains", label: "JetBrains Mono" },
  { value: "fira-code", label: "Fira Code" },
  { value: "ibm-plex-mono", label: "IBM Plex Mono" },
  { value: "system-mono", label: "System monospace" },
];

const UI_FONT_SIZE_OPTIONS: { value: UiFontSizeScale; label: string; description: string }[] = [
  { value: "compact", label: "Compact", description: "Smaller base size (14px)" },
  { value: "normal", label: "Normal", description: "Default (15px)" },
  { value: "comfortable", label: "Comfortable", description: "Larger base size (16px)" },
];

const UI_LETTER_SPACING_OPTIONS: { value: UiLetterSpacing; label: string }[] = [
  { value: "tight", label: "Tight" },
  { value: "normal", label: "Normal" },
  { value: "relaxed", label: "Relaxed" },
];

const UI_FONT_FAMILY_VALUE_SET = new Set(UI_FONT_FAMILY_OPTIONS.map((o) => o.value));
const UI_MONO_FONT_VALUE_SET = new Set(UI_MONO_FONT_OPTIONS.map((o) => o.value));
const UI_FONT_SIZE_VALUE_SET = new Set(UI_FONT_SIZE_OPTIONS.map((o) => o.value));
const UI_LETTER_SPACING_VALUE_SET = new Set(UI_LETTER_SPACING_OPTIONS.map((o) => o.value));

function parseDelimitedValues(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

const LSP_CATEGORY_LABELS: Record<ServerLspToolStatus["category"], string> = {
  core: "Core",
  config: "Config",
  markup: "Markup",
  framework: "Frameworks",
  data: "Data",
  shell: "Shell",
  infra: "Infra",
  custom: "Custom",
};

const LSP_INSTALLER_LABELS: Record<ServerLspToolInstaller, string> = {
  npm: "npm",
  "uv-tool": "uv",
  "go-install": "go",
  rustup: "rustup",
};

const EMPTY_LSP_TOOL_LIST: readonly ServerLspToolStatus[] = [];

function getLspToolSearchText(tool: ServerLspToolStatus): string {
  return [
    tool.label,
    tool.description,
    tool.installer,
    tool.packageName,
    tool.command,
    ...tool.tags,
    ...tool.languageIds,
    ...tool.fileExtensions,
    ...tool.fileNames,
  ]
    .join(" ")
    .toLowerCase();
}

function getLspToolStatusBadgeVariant(tool: ServerLspToolStatus): "success" | "warning" {
  return tool.installed ? "success" : "warning";
}

function resolveNotificationSettingsUrl(): string | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) {
    return "x-apple.systempreferences:com.apple.preference.notifications";
  }
  if (platform.includes("windows")) {
    return "ms-settings:notifications";
  }
  return null;
}

type InstallProviderSettings = {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  cliUrlPlaceholder?: string;
  cliUrlDescription?: ReactNode;
  homePathKey?: "codexHomePath";
  homePlaceholder?: string;
  homeDescription?: ReactNode;
};

const PROVIDER_SETTINGS: readonly InstallProviderSettings[] = [
  {
    provider: "codex",
    title: "Codex",
    binaryPlaceholder: "Codex binary path",
    binaryDescription: "Path to the Codex binary",
    homePathKey: "codexHomePath",
    homePlaceholder: "CODEX_HOME",
    homeDescription: "Optional custom Codex home and config directory.",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    binaryPlaceholder: "Claude binary path",
    binaryDescription: "Path to the Claude binary",
  },
  {
    provider: "githubCopilot",
    title: "Copilot",
    binaryPlaceholder: "Copilot binary path",
    binaryDescription: "Path to the Copilot CLI binary",
    cliUrlPlaceholder: "localhost:4321",
    cliUrlDescription:
      "Optional: connect to an external headless Copilot CLI server instead of spawning per session.",
  },
  {
    provider: "cursor",
    title: "Cursor",
    binaryPlaceholder: "Cursor binary path",
    binaryDescription: "Path to the Cursor Agent binary",
  },
  {
    provider: "gemini",
    title: "Gemini",
    binaryPlaceholder: "Gemini binary path",
    binaryDescription: "Path to the Gemini CLI binary",
  },
  {
    provider: "opencode",
    title: "OpenCode",
    binaryPlaceholder: "OpenCode binary path",
    binaryDescription: "Path to the OpenCode binary",
  },
] as const;

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return fallback;
}

const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const runningAgentCount = useStore(
    (store) => store.threads.filter((thread) => thread.session?.status === "running").length,
  );

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const api = readNativeApi() ?? ensureNativeApi();
      void (async () => {
        const confirmed = await api.dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
            runningAgentCount,
          ),
        );
        if (!confirmed) return;
        const result = await bridge.installUpdate();
        setDesktopUpdateStateQueryData(queryClient, result.state);
      })().catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not install update",
          description: error instanceof Error ? error.message : "Install failed.",
        });
      });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [queryClient, runningAgentCount, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: "Download",
    install: "Install",
  };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available for desktop, web UI, server daemon, and CLI."
      : "Current desktop, web UI, daemon runtime, and CLI version.";

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

function AboutCliInstallTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Command line</span>
      <code className="text-[11px] font-medium text-muted-foreground">ace</code>
    </span>
  );
}

function getCliInstallDescription(state: DesktopCliInstallState | null): string {
  if (!state || state.status === "checking" || state.status === "installing") {
    return "Preparing the packaged `ace` command for terminal use.";
  }
  if (state.status === "ready") {
    return "Launch ace from any new terminal session with the `ace` command.";
  }
  if (state.status === "unsupported") {
    return "This desktop build cannot install the packaged `ace` command.";
  }
  return "Install the packaged `ace` command so new terminal sessions can launch ace directly.";
}

function getCliInstallButtonLabel(
  state: DesktopCliInstallState | null,
  isInstalling: boolean,
): string {
  if (isInstalling || state?.status === "installing") {
    return "Installing…";
  }
  if (!state || state.status === "checking") {
    return "Checking…";
  }
  if (state.status === "unsupported") {
    return "Unavailable";
  }
  if (state.status === "ready") {
    return "Reinstall CLI";
  }
  return "Install CLI";
}

function AboutCliInstallSection() {
  const queryClient = useQueryClient();
  const cliInstallQuery = useDesktopCliInstallState();
  const cliInstallState = cliInstallQuery.data ?? null;
  const [isInstalling, setIsInstalling] = useState(false);
  const cliInstallBridge = window.desktopBridge;

  const handleInstallCli = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.installCli !== "function") {
      return;
    }

    setIsInstalling(true);
    void bridge
      .installCli()
      .then((result) => {
        setDesktopCliInstallStateQueryData(queryClient, result.state);
        if (result.accepted && result.completed) {
          toastManager.add({
            type: "success",
            title: result.state.restartRequired ? "CLI installed" : "CLI ready",
            description: result.state.message ?? "The `ace` command is ready to use.",
          });
          return;
        }

        if (!result.completed && result.state.message) {
          toastManager.add({
            type: "error",
            title: "Could not install CLI",
            description: result.state.message,
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not install CLI",
          description: error instanceof Error ? error.message : "CLI installation failed.",
        });
      })
      .finally(() => {
        setIsInstalling(false);
      });
  }, [queryClient]);

  const buttonDisabled =
    isInstalling ||
    !cliInstallBridge ||
    typeof cliInstallBridge.installCli !== "function" ||
    cliInstallState === null ||
    cliInstallState?.status === "checking" ||
    cliInstallState?.status === "installing" ||
    cliInstallState?.status === "unsupported";

  const status = cliInstallState ? (
    <div className="space-y-2">
      {cliInstallState.commandPath ? (
        <div className="space-y-0.5">
          <span className="block">Command shim</span>
          <code className="block break-all font-mono text-[11px] text-foreground">
            {cliInstallState.commandPath}
          </code>
        </div>
      ) : null}
      {cliInstallState.pathTargets.length > 0 ? (
        <div className="space-y-0.5">
          <span className="block">PATH targets</span>
          {cliInstallState.pathTargets.map((target) => (
            <code key={target} className="block break-all font-mono text-[11px] text-foreground">
              {target}
            </code>
          ))}
        </div>
      ) : null}
      {cliInstallState.message ? (
        <span
          className={cn(
            "block",
            cliInstallState.status === "error" && "text-destructive",
            cliInstallState.status === "ready" && "text-foreground",
          )}
        >
          {cliInstallState.message}
        </span>
      ) : null}
    </div>
  ) : (
    "Checking CLI installation…"
  );

  return (
    <SettingsRow
      title={<AboutCliInstallTitle />}
      description={getCliInstallDescription(cliInstallState)}
      status={status}
      control={
        <Button
          size="xs"
          variant={cliInstallState?.status === "ready" ? "outline" : "default"}
          disabled={buttonDisabled}
          onClick={handleInstallCli}
        >
          {getCliInstallButtonLabel(cliInstallState, isInstalling)}
        </Button>
      }
    />
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const { theme, setTheme } = useTheme();
  const { themePreset } = useAppearancePrefs();
  const settings = useSettings();
  const { resetSettings } = useUpdateSettings();

  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const areProviderSettingsDirty = PROVIDER_SETTINGS.some((providerSettings) => {
    const currentSettings = settings.providers[providerSettings.provider];
    const defaultSettings = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    return !Equal.equals(currentSettings, defaultSettings);
  });

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Theme"] : []),
      ...(themePreset !== DEFAULT_THEME_PRESET ? ["Theme preset"] : []),
      ...(settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? ["UI font"] : []),
      ...(settings.uiMonoFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiMonoFontFamily
        ? ["Monospace font"]
        : []),
      ...(settings.uiFontSizeScale !== DEFAULT_UNIFIED_SETTINGS.uiFontSizeScale
        ? ["Text size"]
        : []),
      ...(settings.uiLetterSpacing !== DEFAULT_UNIFIED_SETTINGS.uiLetterSpacing
        ? ["Letter spacing"]
        : []),
      ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine
        ? ["Browser search engine"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Time format"]
        : []),
      ...(settings.workspaceEditorOpenMode !== DEFAULT_UNIFIED_SETTINGS.workspaceEditorOpenMode
        ? ["Workspace editor open mode"]
        : []),
      ...(settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap
        ? ["Diff line wrapping"]
        : []),
      ...(settings.editorLineNumbers !== DEFAULT_UNIFIED_SETTINGS.editorLineNumbers
        ? ["Editor line numbers"]
        : []),
      ...(settings.editorMinimap !== DEFAULT_UNIFIED_SETTINGS.editorMinimap
        ? ["Editor minimap"]
        : []),
      ...(settings.editorRenderWhitespace !== DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace
        ? ["Editor whitespace"]
        : []),
      ...(settings.editorStickyScroll !== DEFAULT_UNIFIED_SETTINGS.editorStickyScroll
        ? ["Editor sticky scroll"]
        : []),
      ...(settings.editorSuggestions !== DEFAULT_UNIFIED_SETTINGS.editorSuggestions
        ? ["Editor suggestions"]
        : []),
      ...(settings.editorWordWrap !== DEFAULT_UNIFIED_SETTINGS.editorWordWrap
        ? ["Editor line wrapping"]
        : []),
      ...(settings.enableAssistantStreaming !== DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming
        ? ["Assistant output"]
        : []),
      ...(settings.enableToolStreaming !== DEFAULT_UNIFIED_SETTINGS.enableToolStreaming
        ? ["Tool activity"]
        : []),
      ...(settings.enableThinkingStreaming !== DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming
        ? ["Thinking activity"]
        : []),
      ...(settings.notifyOnAgentCompletion !== DEFAULT_UNIFIED_SETTINGS.notifyOnAgentCompletion
        ? ["Completion notifications"]
        : []),
      ...(settings.notifyOnApprovalRequired !== DEFAULT_UNIFIED_SETTINGS.notifyOnApprovalRequired
        ? ["Approval notifications"]
        : []),
      ...(settings.notifyOnUserInputRequired !== DEFAULT_UNIFIED_SETTINGS.notifyOnUserInputRequired
        ? ["Input notifications"]
        : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["New thread mode"]
        : []),
      ...(settings.gitSshKeyPassphrase !== DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase
        ? ["Git SSH key passphrase"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Add project base directory"]
        : []),
      ...(settings.providerCliMaxOpen !== DEFAULT_UNIFIED_SETTINGS.providerCliMaxOpen
        ? ["Provider CLI max open"]
        : []),
      ...(settings.providerCliIdleTtlSeconds !== DEFAULT_UNIFIED_SETTINGS.providerCliIdleTtlSeconds
        ? ["Provider CLI idle timeout"]
        : []),
      ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
        ? ["Archive confirmation"]
        : []),
      ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
        ? ["Delete confirmation"]
        : []),
      ...(settings.threadHydrationCacheMemoryMb !==
      DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb
        ? ["Thread cache budget"]
        : []),
      ...(isGitWritingModelDirty ? ["Git writing model"] : []),
      ...(areProviderSettingsDirty ? ["Providers"] : []),
    ],
    [
      areProviderSettingsDirty,
      settings.browserSearchEngine,
      isGitWritingModelDirty,
      settings.confirmThreadArchive,
      settings.confirmThreadDelete,
      settings.defaultThreadEnvMode,
      settings.gitSshKeyPassphrase,
      settings.addProjectBaseDirectory,
      settings.providerCliIdleTtlSeconds,
      settings.providerCliMaxOpen,
      settings.diffWordWrap,
      settings.editorLineNumbers,
      settings.editorMinimap,
      settings.editorRenderWhitespace,
      settings.editorStickyScroll,
      settings.editorSuggestions,
      settings.editorWordWrap,
      settings.enableAssistantStreaming,
      settings.notifyOnAgentCompletion,
      settings.notifyOnApprovalRequired,
      settings.notifyOnUserInputRequired,
      settings.enableThinkingStreaming,
      settings.enableToolStreaming,
      settings.threadHydrationCacheMemoryMb,
      settings.timestampFormat,
      settings.uiFontFamily,
      settings.uiFontSizeScale,
      settings.uiLetterSpacing,
      settings.uiMonoFontFamily,
      settings.workspaceEditorOpenMode,
      theme,
      themePreset,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readNativeApi();
    const confirmed = await (api ?? ensureNativeApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
    );
    if (!confirmed) return;

    setTheme("system");
    resetThemePresetToDefault();
    resetSettings();
    onRestored?.();
  }, [changedSettingLabels, onRestored, resetSettings, setTheme]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

type SettingsPanelPage =
  | "general"
  | "chat"
  | "editor"
  | "browser"
  | "models"
  | "providers"
  | "advanced"
  | "about";

function SettingsPanel({ page }: { page: SettingsPanelPage }) {
  const { theme, setTheme } = useTheme();
  const { themePreset, setThemePreset } = useAppearancePrefs();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [notificationPermission, setNotificationPermission] =
    useState<AgentAttentionNotificationPermission>(() =>
      isElectron ? "default" : readAgentAttentionNotificationPermission(),
    );
  const [isUpdatingNotificationPermission, setIsUpdatingNotificationPermission] = useState(false);
  const [openProviderDetails, setOpenProviderDetails] = useState<Record<ProviderKind, boolean>>({
    codex: Boolean(
      settings.providers.codex.binaryPath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.binaryPath ||
      settings.providers.codex.homePath !== DEFAULT_UNIFIED_SETTINGS.providers.codex.homePath ||
      settings.providers.codex.customModels.length > 0,
    ),
    claudeAgent: Boolean(
      settings.providers.claudeAgent.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.claudeAgent.binaryPath ||
      settings.providers.claudeAgent.customModels.length > 0,
    ),
    githubCopilot: Boolean(
      settings.providers.githubCopilot.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.githubCopilot.binaryPath ||
      settings.providers.githubCopilot.customModels.length > 0,
    ),
    cursor: Boolean(
      settings.providers.cursor.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.cursor.binaryPath ||
      settings.providers.cursor.customModels.length > 0,
    ),
    gemini: Boolean(
      settings.providers.gemini.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.gemini.binaryPath ||
      settings.providers.gemini.customModels.length > 0,
    ),
    opencode: Boolean(
      settings.providers.opencode.binaryPath !==
        DEFAULT_UNIFIED_SETTINGS.providers.opencode.binaryPath ||
      settings.providers.opencode.customModels.length > 0,
    ),
  });
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    githubCopilot: "",
    cursor: "",
    gemini: "",
    opencode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [lspToolsStatus, setLspToolsStatus] = useState<ServerLspToolsStatus | null>(null);
  const [lspToolsError, setLspToolsError] = useState<string | null>(null);
  const [isInstallingLspTools, setIsInstallingLspTools] = useState(false);
  const [lspCatalogQuery, setLspCatalogQuery] = useState("");
  const [lspCatalogCategory, setLspCatalogCategory] = useState<
    "all" | ServerLspToolStatus["category"]
  >("all");
  const [isInstallingCustomLsp, setIsInstallingCustomLsp] = useState(false);
  const [lspInstallTargetId, setLspInstallTargetId] = useState<string | null>(null);
  const [isLspCustomFormOpen, setIsLspCustomFormOpen] = useState(false);
  const [lspCustomForm, setLspCustomForm] = useState<{
    installer: ServerLspToolInstaller;
    packageName: string;
    command: string;
    label: string;
    args: string;
    languageIds: string;
    fileExtensions: string;
    fileNames: string;
  }>({
    installer: "npm",
    packageName: "",
    command: "",
    label: "",
    args: "",
    languageIds: "",
    fileExtensions: "",
    fileNames: "",
  });
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);
  const canOpenNotificationSystemSettings = useMemo(
    () => isElectron && resolveNotificationSettingsUrl() !== null,
    [],
  );
  const hasAnyAgentAttentionNotificationsEnabled =
    settings.notifyOnAgentCompletion ||
    settings.notifyOnApprovalRequired ||
    settings.notifyOnUserInputRequired;
  const setAgentAttentionNotificationToggles = useCallback(
    (enabled: boolean) => {
      updateSettings(buildAgentAttentionNotificationSettingsPatch(enabled));
    },
    [updateSettings],
  );
  const notificationPermissionDescription = useMemo(() => {
    switch (notificationPermission) {
      case "granted":
        return "OS notifications are enabled for ace.";
      case "denied":
        return canOpenNotificationSystemSettings
          ? "OS notifications are blocked. Open system settings to allow them for ace."
          : isElectron
            ? "OS notifications are blocked for this app."
            : "Browser notifications are blocked for this site/profile. Allow notifications in site settings, then refresh.";
      case "default":
        return "Notification permission has not been requested yet.";
      default:
        return "Notifications are not supported in this runtime.";
    }
  }, [canOpenNotificationSystemSettings, notificationPermission]);

  const refreshNotificationPermission = useCallback(() => {
    if (typeof window === "undefined") {
      return Promise.resolve<AgentAttentionNotificationPermission>("unsupported");
    }
    if (isElectron && typeof window.desktopBridge?.getNotificationPermission === "function") {
      return window.desktopBridge
        .getNotificationPermission()
        .then((permission) => {
          setNotificationPermission(permission);
          return permission;
        })
        .catch(() => {
          setNotificationPermission("unsupported");
          return "unsupported" as const;
        });
    }
    const permission = readAgentAttentionNotificationPermission();
    setNotificationPermission(permission);
    return Promise.resolve(permission);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const syncPermission = () => {
      if (isElectron && typeof window.desktopBridge?.getNotificationPermission === "function") {
        void window.desktopBridge
          .getNotificationPermission()
          .then((permission) => {
            setNotificationPermission(permission);
          })
          .catch(() => {
            setNotificationPermission("unsupported");
          });
        return;
      }
      setNotificationPermission(readAgentAttentionNotificationPermission());
    };
    syncPermission();
    document.addEventListener("visibilitychange", syncPermission);
    window.addEventListener("focus", syncPermission);
    return () => {
      document.removeEventListener("visibilitychange", syncPermission);
      window.removeEventListener("focus", syncPermission);
    };
  }, []);

  const sendNotificationProbe = useCallback(() => {
    const probeId = `ace-notification-permission-probe:${Date.now().toString(36)}`;
    if (isElectron && typeof window.desktopBridge?.showNotification === "function") {
      return window.desktopBridge.showNotification({
        id: probeId,
        title: "ace notifications",
        body: "You'll get alerts when agent work completes or needs input.",
      });
    }
    return showBrowserNotification({
      title: "ace notifications",
      body: "You'll get alerts when agent work completes or needs input.",
      tag: probeId,
    }).then((result) => result.shown);
  }, []);

  const handleSendNotificationTest = useCallback(() => {
    setIsUpdatingNotificationPermission(true);
    void refreshNotificationPermission()
      .then(async (permission) => {
        if (permission !== "granted") {
          toastManager.add({
            type: "warning",
            title: "Notifications are not enabled",
            description:
              permission === "denied"
                ? "Allow notifications for ace before sending a test."
                : "Request notification permission before sending a test.",
          });
          return;
        }
        const opened = await sendNotificationProbe();
        if (opened) {
          toastManager.add({
            type: "success",
            title: "Test notification sent",
            description: "If you do not see it, check Focus, Do Not Disturb, and OS settings.",
          });
          return;
        }
        toastManager.add({
          type: "warning",
          title: "Test notification was not shown",
          description: isElectron
            ? "The desktop notification API rejected the test notification."
            : "The browser rejected the test notification for this site.",
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to send test notification",
          description: error instanceof Error ? error.message : "Unknown notification error.",
        });
      })
      .finally(() => {
        void refreshNotificationPermission();
        setIsUpdatingNotificationPermission(false);
      });
  }, [refreshNotificationPermission, sendNotificationProbe]);

  const enableNotifications = useCallback(
    (enabledKeys?: readonly AgentAttentionNotificationSettingKey[]) => {
      setIsUpdatingNotificationPermission(true);
      const permissionRequest =
        isElectron && typeof window.desktopBridge?.requestNotificationPermission === "function"
          ? window.desktopBridge.requestNotificationPermission()
          : requestAgentAttentionNotificationPermission();

      void permissionRequest
        .then(async (permission) => {
          setNotificationPermission(permission);
          if (permission === "granted") {
            await sendNotificationProbe();
            if (enabledKeys && enabledKeys.length > 0) {
              updateSettings(buildScopedAgentAttentionNotificationSettingsPatch(enabledKeys, true));
            } else {
              setAgentAttentionNotificationToggles(true);
            }
            return;
          }
          if (permission === "denied") {
            toastManager.add({
              type: "warning",
              title: isElectron
                ? "Notifications blocked by system settings"
                : "Notifications blocked",
              description: canOpenNotificationSystemSettings
                ? "Open system settings and allow notifications for ace."
                : "Allow notifications for ace in your browser or operating system settings.",
            });
            return;
          }
          if (permission === "default") {
            toastManager.add({
              type: "warning",
              title: "Notification permission still pending",
              description:
                "If no prompt appeared, open notification settings and allow ace manually.",
            });
            return;
          }
          toastManager.add({
            type: "warning",
            title: "Notifications unavailable",
            description: "This runtime does not support desktop notifications.",
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Unable to request notification permission",
            description:
              error instanceof Error ? error.message : "Unknown notification permission error.",
          });
        })
        .finally(() => {
          void refreshNotificationPermission();
          setIsUpdatingNotificationPermission(false);
        });
    },
    [
      canOpenNotificationSystemSettings,
      refreshNotificationPermission,
      sendNotificationProbe,
      setAgentAttentionNotificationToggles,
      updateSettings,
    ],
  );

  const disableNotifications = useCallback(() => {
    setAgentAttentionNotificationToggles(false);
  }, [setAgentAttentionNotificationToggles]);

  const openNotificationSettings = useCallback(() => {
    const targetUrl = resolveNotificationSettingsUrl();
    if (!targetUrl) {
      toastManager.add({
        type: "warning",
        title: "Open notification settings",
        description: isElectron
          ? "Open your operating system notification settings and allow ace."
          : "Open your browser site settings and allow notifications for this site.",
      });
      return;
    }
    setIsUpdatingNotificationPermission(true);
    void (window.desktopBridge?.openExternal(targetUrl) ?? Promise.resolve(false))
      .then((opened) => {
        if (!opened) {
          toastManager.add({
            type: "warning",
            title: "Unable to open notification settings",
            description: "Open your operating system notification settings manually.",
          });
        }
        void refreshNotificationPermission();
      })
      .finally(() => {
        setIsUpdatingNotificationPermission(false);
      });
  }, [refreshNotificationPermission]);

  const handleNotificationToggleChange = useCallback(
    (key: AgentAttentionNotificationSettingKey, checked: boolean) => {
      const intent = resolveNotificationToggleChangeIntent({
        checked,
        key,
        permission: notificationPermission,
      });
      if (intent.kind === "request-permission") {
        enableNotifications(intent.keys);
        return;
      }
      updateSettings(intent.patch);
    },
    [enableNotifications, notificationPermission, updateSettings],
  );

  const serverProviders = useServerProviders();
  const codexHomePath = settings.providers.codex.homePath;

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenProvider = textGenerationModelSelection.provider;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelOptionsByProvider = getCustomModelOptionsByProvider(
    settings,
    serverProviders,
    textGenProvider,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = settings.providers[provider].customModels;
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (
        serverProviders
          .find((candidate) => candidate.provider === provider)
          ?.models.some((option) => !option.isCustom && option.slug === normalized)
      ) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: [...customModels, normalized],
          },
        },
      });
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));

      const el = modelListRefs.current[provider];
      if (!el) return;
      const scrollToEnd = () => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      requestAnimationFrame(scrollToEnd);
      const observer = new MutationObserver(() => {
        scrollToEnd();
        observer.disconnect();
      });
      observer.observe(el, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 2_000);
    },
    [customModelInputByProvider, serverProviders, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      updateSettings({
        providers: {
          ...settings.providers,
          [provider]: {
            ...settings.providers[provider],
            customModels: settings.providers[provider].customModels.filter(
              (model) => model !== slug,
            ),
          },
        },
      });
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  const providerCards: ProviderCard[] = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProvider = serverProviders.find(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const providerConfig = settings.providers[providerSettings.provider];
    const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerSettings.provider];
    const statusKey = liveProvider?.status ?? (providerConfig.enabled ? "warning" : "disabled");
    const summary = getProviderSummary(liveProvider);
    const selectedModels = providerConfig.customModels.map((slug) => ({
      slug,
      name: formatProviderModelDisplayName(providerSettings.provider, slug),
      isCustom: true,
      capabilities: null,
    }));
    const models = liveProvider?.models ?? selectedModels;

    return {
      provider: providerSettings.provider,
      title: providerSettings.title,
      binaryPlaceholder: providerSettings.binaryPlaceholder,
      binaryDescription: providerSettings.binaryDescription,
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      binaryPathValue: providerConfig.binaryPath,
      cliUrlValue:
        providerSettings.provider === "githubCopilot"
          ? settings.providers.githubCopilot.cliUrl
          : undefined,
      cliUrlPlaceholder: providerSettings.cliUrlPlaceholder,
      cliUrlDescription: providerSettings.cliUrlDescription,
      isDirty: !Equal.equals(providerConfig, defaultProviderConfig),
      models,
      providerConfig,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      versionLabel: getProviderVersionLabel(liveProvider?.version),
    };
  });

  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const isGeneralPage = page === "general";
  const isChatPage = page === "chat";
  const isEditorPage = page === "editor";
  const isBrowserPage = page === "browser";
  const isModelsPage = page === "models";
  const isProvidersPage = page === "providers";
  const isAdvancedPage = page === "advanced";
  const isAboutPage = page === "about";
  const lspTools = lspToolsStatus?.tools ?? EMPTY_LSP_TOOL_LIST;
  const lspCoreTools = useMemo(() => lspTools.filter((tool) => tool.builtin), [lspTools]);
  const lspCatalogTools = useMemo(
    () => lspTools.filter((tool) => tool.source !== "custom"),
    [lspTools],
  );
  const lspCustomTools = useMemo(
    () => lspTools.filter((tool) => tool.source === "custom"),
    [lspTools],
  );
  const lspCoreToolsInstalled =
    lspCoreTools.length > 0 && lspCoreTools.every((tool) => tool.installed);
  const filteredLspCatalogTools = useMemo(() => {
    const normalizedQuery = lspCatalogQuery.trim().toLowerCase();
    return lspCatalogTools.filter((tool) => {
      if (lspCatalogCategory !== "all" && tool.category !== lspCatalogCategory) {
        return false;
      }
      if (normalizedQuery.length === 0) {
        return true;
      }
      return getLspToolSearchText(tool).includes(normalizedQuery);
    });
  }, [lspCatalogCategory, lspCatalogQuery, lspCatalogTools]);
  const lspCatalogCategories = useMemo(
    () =>
      Array.from(
        new Set(
          lspCatalogTools.map((tool) => tool.category).filter((category) => category !== "custom"),
        ),
      ),
    [lspCatalogTools],
  );

  const refreshLspToolsStatus = useCallback(() => {
    void ensureNativeApi()
      .server.getLspToolsStatus()
      .then((status) => {
        setLspToolsStatus(status);
        setLspToolsError(null);
      })
      .catch((error: unknown) => {
        setLspToolsError(getErrorMessage(error, "Unable to load LSP tool status."));
      });
  }, []);

  const installLspToolsFromSettings = useCallback((reinstall: boolean) => {
    setIsInstallingLspTools(true);
    setLspToolsError(null);
    void ensureNativeApi()
      .server.installLspTools({ reinstall })
      .then((status) => {
        setLspToolsStatus(status);
        toastManager.add({
          type: "success",
          title: "Language server tools are ready.",
        });
      })
      .catch((error: unknown) => {
        setLspToolsError(getErrorMessage(error, "Unable to install LSP tools."));
      })
      .finally(() => setIsInstallingLspTools(false));
  }, []);

  const installCustomLspTool = useCallback(
    (input: ServerInstallLspToolInput, installTargetId: string | null = null) => {
      setIsInstallingCustomLsp(true);
      setLspInstallTargetId(installTargetId);
      setLspToolsError(null);
      void ensureNativeApi()
        .server.installLspTool(input)
        .then((status) => {
          setLspToolsStatus(status);
          toastManager.add({
            type: "success",
            title: `Installed ${input.label}.`,
          });
        })
        .catch((error: unknown) => {
          setLspToolsError(getErrorMessage(error, "Unable to install custom language server."));
        })
        .finally(() => {
          setIsInstallingCustomLsp(false);
          setLspInstallTargetId(null);
        });
    },
    [],
  );

  const installCatalogTool = useCallback(
    (tool: ServerLspToolStatus) => {
      installCustomLspTool(
        {
          packageName: tool.packageName,
          command: tool.command,
          label: tool.label,
          installer: tool.installer,
          description: tool.description,
          args: tool.args,
          installPackages: tool.installPackages,
          languageIds: tool.languageIds,
          fileExtensions: tool.fileExtensions,
          fileNames: tool.fileNames,
          ...(tool.installed ? { reinstall: true } : {}),
        },
        tool.id,
      );
    },
    [installCustomLspTool],
  );

  const seedCustomLspForm = useCallback((tool?: ServerLspToolStatus) => {
    if (tool) {
      setLspCustomForm({
        installer: tool.installer,
        packageName: tool.packageName,
        command: tool.command,
        label: tool.label,
        args: tool.args.join(", "),
        languageIds: tool.languageIds.join(", "),
        fileExtensions: tool.fileExtensions.join(", "),
        fileNames: tool.fileNames.join(", "),
      });
    }
    setIsLspCustomFormOpen(true);
  }, []);

  const submitCustomLspInstall = useCallback(() => {
    const installer = lspCustomForm.installer;
    const packageName = lspCustomForm.packageName.trim();
    const command = lspCustomForm.command.trim();
    const label = lspCustomForm.label.trim();
    const languageIds = parseDelimitedValues(lspCustomForm.languageIds);
    const fileExtensions = parseDelimitedValues(lspCustomForm.fileExtensions).map((value) =>
      value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`,
    );
    const fileNames = parseDelimitedValues(lspCustomForm.fileNames);
    const args = parseDelimitedValues(lspCustomForm.args);
    if (
      !packageName ||
      !command ||
      !label ||
      languageIds.length === 0 ||
      (fileExtensions.length === 0 && fileNames.length === 0)
    ) {
      setLspToolsError(
        "Package, command, label, language IDs, and at least one file extension or file name are required.",
      );
      return;
    }
    installCustomLspTool(
      {
        installer,
        packageName,
        command,
        label,
        languageIds,
        fileExtensions,
        ...(fileNames.length > 0 ? { fileNames } : {}),
        ...(args.length > 0 ? { args } : {}),
      },
      "custom-form",
    );
  }, [installCustomLspTool, lspCustomForm]);

  useEffect(() => {
    if (!isEditorPage || lspToolsStatus) return;
    refreshLspToolsStatus();
  }, [isEditorPage, lspToolsStatus, refreshLspToolsStatus]);

  return (
    <SettingsPageContainer>
      {isGeneralPage ? (
        <>
          <SettingsSection title="Appearance">
            <SettingsRow
              title="Theme"
              description="Light, dark, or follow the system appearance."
              resetAction={
                theme !== "system" ? (
                  <SettingResetButton label="theme" onClick={() => setTheme("system")} />
                ) : null
              }
              control={
                <Select
                  value={theme}
                  onValueChange={(value) => {
                    if (value === "system" || value === "light" || value === "dark") {
                      setTheme(value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                    <SelectValue>
                      {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {THEME_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Theme presets"
              description="Pick a full palette (surfaces + primary). Cards show a dark preview strip; the app follows your light/dark theme setting."
              resetAction={
                themePreset !== DEFAULT_THEME_PRESET ? (
                  <SettingResetButton
                    label="theme preset"
                    onClick={() => setThemePreset(DEFAULT_THEME_PRESET)}
                  />
                ) : null
              }
            >
              <ThemePresetPicker
                className="mt-3 w-full"
                value={themePreset}
                onChange={setThemePreset}
              />
            </SettingsRow>

            <SettingsRow
              title="UI font"
              description="Sans-serif typeface for interface text, sidebars, and chat."
              resetAction={
                settings.uiFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiFontFamily ? (
                  <SettingResetButton
                    label="UI font"
                    onClick={() => updateSettings({ uiFontFamily: DEFAULT_UI_FONT_FAMILY })}
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.uiFontFamily}
                  onValueChange={(value) => {
                    if (value != null && UI_FONT_FAMILY_VALUE_SET.has(value)) {
                      updateSettings({ uiFontFamily: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label="UI font">
                    <SelectValue>
                      {UI_FONT_FAMILY_OPTIONS.find((o) => o.value === settings.uiFontFamily)
                        ?.label ?? "UI font"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {UI_FONT_FAMILY_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Monospace font"
              description="Used for code, diffs, inputs, and the integrated terminal."
              resetAction={
                settings.uiMonoFontFamily !== DEFAULT_UNIFIED_SETTINGS.uiMonoFontFamily ? (
                  <SettingResetButton
                    label="monospace font"
                    onClick={() =>
                      updateSettings({ uiMonoFontFamily: DEFAULT_UI_MONO_FONT_FAMILY })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.uiMonoFontFamily}
                  onValueChange={(value) => {
                    if (value != null && UI_MONO_FONT_VALUE_SET.has(value)) {
                      updateSettings({ uiMonoFontFamily: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label="Monospace font">
                    <SelectValue>
                      {UI_MONO_FONT_OPTIONS.find((o) => o.value === settings.uiMonoFontFamily)
                        ?.label ?? "Monospace font"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {UI_MONO_FONT_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Text size"
              description="Scales the base size of the interface (affects spacing that uses rem units)."
              resetAction={
                settings.uiFontSizeScale !== DEFAULT_UNIFIED_SETTINGS.uiFontSizeScale ? (
                  <SettingResetButton
                    label="text size"
                    onClick={() => updateSettings({ uiFontSizeScale: DEFAULT_UI_FONT_SIZE_SCALE })}
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.uiFontSizeScale}
                  onValueChange={(value) => {
                    if (value != null && UI_FONT_SIZE_VALUE_SET.has(value)) {
                      updateSettings({ uiFontSizeScale: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-56" aria-label="Text size">
                    <SelectValue>
                      {UI_FONT_SIZE_OPTIONS.find((o) => o.value === settings.uiFontSizeScale)
                        ?.label ?? "Text size"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {UI_FONT_SIZE_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        <span className="flex flex-col gap-0.5">
                          <span>{option.label}</span>
                          <span className="text-[11px] font-normal text-muted-foreground">
                            {option.description}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Letter spacing"
              description="Adjusts tracking for body text."
              resetAction={
                settings.uiLetterSpacing !== DEFAULT_UNIFIED_SETTINGS.uiLetterSpacing ? (
                  <SettingResetButton
                    label="letter spacing"
                    onClick={() => updateSettings({ uiLetterSpacing: DEFAULT_UI_LETTER_SPACING })}
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.uiLetterSpacing}
                  onValueChange={(value) => {
                    if (value != null && UI_LETTER_SPACING_VALUE_SET.has(value)) {
                      updateSettings({ uiLetterSpacing: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Letter spacing">
                    <SelectValue>
                      {UI_LETTER_SPACING_OPTIONS.find((o) => o.value === settings.uiLetterSpacing)
                        ?.label ?? "Letter spacing"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {UI_LETTER_SPACING_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Time format"
              description="System default follows your browser or OS clock preference."
              resetAction={
                settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
                  <SettingResetButton
                    label="time format"
                    onClick={() =>
                      updateSettings({
                        timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.timestampFormat}
                  onValueChange={(value) => {
                    if (value === "locale" || value === "12-hour" || value === "24-hour") {
                      updateSettings({ timestampFormat: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                    <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="locale">
                      {TIMESTAMP_FORMAT_LABELS.locale}
                    </SelectItem>
                    <SelectItem hideIndicator value="12-hour">
                      {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                    </SelectItem>
                    <SelectItem hideIndicator value="24-hour">
                      {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
          </SettingsSection>

          <SettingsSection title="Defaults">
            <SettingsRow
              title="New threads"
              description="Pick the default workspace mode for newly created draft threads."
              resetAction={
                settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
                  <SettingResetButton
                    label="new threads"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.defaultThreadEnvMode}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      updateSettings({ defaultThreadEnvMode: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Default thread mode">
                    <SelectValue>
                      {settings.defaultThreadEnvMode === "worktree" ? "New worktree" : "Local"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="local">
                      Local
                    </SelectItem>
                    <SelectItem hideIndicator value="worktree">
                      New worktree
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Workspace editor opening mode"
              description="Choose whether opening the workspace editor from chat starts in split view or full editor."
              resetAction={
                settings.workspaceEditorOpenMode !==
                DEFAULT_UNIFIED_SETTINGS.workspaceEditorOpenMode ? (
                  <SettingResetButton
                    label="workspace editor opening mode"
                    onClick={() =>
                      updateSettings({
                        workspaceEditorOpenMode: DEFAULT_UNIFIED_SETTINGS.workspaceEditorOpenMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.workspaceEditorOpenMode}
                  onValueChange={(value) => {
                    if (value === "split" || value === "full") {
                      updateSettings({ workspaceEditorOpenMode: value });
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full sm:w-44"
                    aria-label="Workspace editor opening mode"
                  >
                    <SelectValue>
                      {settings.workspaceEditorOpenMode === "split" ? "Split view" : "Full editor"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="split">
                      Split view
                    </SelectItem>
                    <SelectItem hideIndicator value="full">
                      Full editor
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Add project starts in"
              description="Optional base directory used when opening the add-project browser."
              resetAction={
                settings.addProjectBaseDirectory !==
                DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
                  <SettingResetButton
                    label="add project start directory"
                    onClick={() =>
                      updateSettings({
                        addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Input
                  className="w-full sm:w-72"
                  value={settings.addProjectBaseDirectory}
                  onChange={(event) => {
                    updateSettings({ addProjectBaseDirectory: event.target.value });
                  }}
                  placeholder="Current project or home directory"
                  aria-label="Add project base directory"
                />
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isChatPage ? (
        <>
          <SettingsSection title="Live output">
            <SettingsRow
              title="Assistant output"
              description="Show token-by-token output while a response is in progress."
              resetAction={
                settings.enableAssistantStreaming !==
                DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
                  <SettingResetButton
                    label="assistant output"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableAssistantStreaming: Boolean(checked) })
                  }
                  aria-label="Stream assistant messages"
                />
              }
            />

            <SettingsRow
              title="Tool activity"
              description="Show tool-call activity in the timeline for current and past responses."
              resetAction={
                settings.enableToolStreaming !== DEFAULT_UNIFIED_SETTINGS.enableToolStreaming ? (
                  <SettingResetButton
                    label="tool activity"
                    onClick={() =>
                      updateSettings({
                        enableToolStreaming: DEFAULT_UNIFIED_SETTINGS.enableToolStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableToolStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableToolStreaming: Boolean(checked) })
                  }
                  aria-label="Show tool activity"
                />
              }
            />

            <SettingsRow
              title="Thinking activity"
              description="Show reasoning and planning updates in the timeline for current and past responses."
              resetAction={
                settings.enableThinkingStreaming !==
                DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming ? (
                  <SettingResetButton
                    label="thinking activity"
                    onClick={() =>
                      updateSettings({
                        enableThinkingStreaming: DEFAULT_UNIFIED_SETTINGS.enableThinkingStreaming,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableThinkingStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableThinkingStreaming: Boolean(checked) })
                  }
                  aria-label="Show thinking activity"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Confirmations">
            <SettingsRow
              title="Archive confirmation"
              description="Require a second click on the inline archive action before a thread is archived."
              resetAction={
                settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
                  <SettingResetButton
                    label="archive confirmation"
                    onClick={() =>
                      updateSettings({
                        confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.confirmThreadArchive}
                  onCheckedChange={(checked) =>
                    updateSettings({ confirmThreadArchive: Boolean(checked) })
                  }
                  aria-label="Confirm thread archiving"
                />
              }
            />

            <SettingsRow
              title="Delete confirmation"
              description="Ask before deleting a thread and its chat history."
              resetAction={
                settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
                  <SettingResetButton
                    label="delete confirmation"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({ confirmThreadDelete: Boolean(checked) })
                  }
                  aria-label="Confirm thread deletion"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Background notifications">
            <SettingsRow
              title="Permission"
              description={notificationPermissionDescription}
              control={
                notificationPermission === "granted" ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUpdatingNotificationPermission}
                      onClick={handleSendNotificationTest}
                    >
                      Send test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUpdatingNotificationPermission}
                      onClick={
                        hasAnyAgentAttentionNotificationsEnabled
                          ? disableNotifications
                          : () => enableNotifications()
                      }
                    >
                      {isUpdatingNotificationPermission
                        ? "Updating..."
                        : hasAnyAgentAttentionNotificationsEnabled
                          ? "Disable"
                          : "Enable"}
                    </Button>
                  </div>
                ) : notificationPermission === "default" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isUpdatingNotificationPermission}
                    onClick={() => enableNotifications()}
                  >
                    {isUpdatingNotificationPermission ? "Requesting..." : "Request permission"}
                  </Button>
                ) : notificationPermission === "denied" && canOpenNotificationSystemSettings ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUpdatingNotificationPermission}
                      onClick={() => enableNotifications()}
                    >
                      Request again
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUpdatingNotificationPermission}
                      onClick={openNotificationSettings}
                    >
                      {isUpdatingNotificationPermission ? "Opening..." : "Open settings"}
                    </Button>
                  </div>
                ) : notificationPermission === "denied" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isUpdatingNotificationPermission}
                    onClick={() => enableNotifications()}
                  >
                    {isUpdatingNotificationPermission ? "Requesting..." : "Request again"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isUpdatingNotificationPermission}
                    onClick={refreshNotificationPermission}
                  >
                    Refresh
                  </Button>
                )
              }
            />

            <SettingsRow
              title="Agent completion"
              description="Send a notification after a turn finishes while the app is not focused."
              resetAction={
                settings.notifyOnAgentCompletion !==
                DEFAULT_UNIFIED_SETTINGS.notifyOnAgentCompletion ? (
                  <SettingResetButton
                    label="completion notifications"
                    onClick={() =>
                      updateSettings({
                        notifyOnAgentCompletion: DEFAULT_UNIFIED_SETTINGS.notifyOnAgentCompletion,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.notifyOnAgentCompletion}
                  onCheckedChange={(checked) =>
                    handleNotificationToggleChange("notifyOnAgentCompletion", Boolean(checked))
                  }
                  aria-label="Notify when the agent completes a turn"
                />
              }
            />

            <SettingsRow
              title="Approval requests"
              description="Send a notification when the agent is blocked on an approval request."
              resetAction={
                settings.notifyOnApprovalRequired !==
                DEFAULT_UNIFIED_SETTINGS.notifyOnApprovalRequired ? (
                  <SettingResetButton
                    label="approval notifications"
                    onClick={() =>
                      updateSettings({
                        notifyOnApprovalRequired: DEFAULT_UNIFIED_SETTINGS.notifyOnApprovalRequired,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.notifyOnApprovalRequired}
                  onCheckedChange={(checked) =>
                    handleNotificationToggleChange("notifyOnApprovalRequired", Boolean(checked))
                  }
                  aria-label="Notify when the agent requires approval"
                />
              }
            />

            <SettingsRow
              title="User input requests"
              description="Send a notification when the agent requests structured user input. On supported desktop platforms, single-question prompts can be answered inline from the notification."
              resetAction={
                settings.notifyOnUserInputRequired !==
                DEFAULT_UNIFIED_SETTINGS.notifyOnUserInputRequired ? (
                  <SettingResetButton
                    label="input notifications"
                    onClick={() =>
                      updateSettings({
                        notifyOnUserInputRequired:
                          DEFAULT_UNIFIED_SETTINGS.notifyOnUserInputRequired,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.notifyOnUserInputRequired}
                  onCheckedChange={(checked) =>
                    handleNotificationToggleChange("notifyOnUserInputRequired", Boolean(checked))
                  }
                  aria-label="Notify when the agent requires user input"
                />
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isEditorPage ? (
        <>
          <SettingsSection title="Diffs">
            <SettingsRow
              title="Diff line wrapping"
              description="Set the default wrap state when the diff panel opens."
              resetAction={
                settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
                  <SettingResetButton
                    label="diff line wrapping"
                    onClick={() =>
                      updateSettings({
                        diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.diffWordWrap}
                  onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
                  aria-label="Wrap diff lines by default"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Workspace editor">
            <SettingsRow
              title="Editor suggestions"
              description="Keep Monaco completion helpers off by default to reduce noisy or unwanted code insertions."
              resetAction={
                settings.editorSuggestions !== DEFAULT_UNIFIED_SETTINGS.editorSuggestions ? (
                  <SettingResetButton
                    label="editor suggestions"
                    onClick={() =>
                      updateSettings({
                        editorSuggestions: DEFAULT_UNIFIED_SETTINGS.editorSuggestions,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorSuggestions}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorSuggestions: Boolean(checked) })
                  }
                  aria-label="Enable workspace editor suggestions"
                />
              }
            />

            <SettingsRow
              title="Editor line wrapping"
              description="Wrap long lines in the workspace editor."
              resetAction={
                settings.editorWordWrap !== DEFAULT_UNIFIED_SETTINGS.editorWordWrap ? (
                  <SettingResetButton
                    label="editor line wrapping"
                    onClick={() =>
                      updateSettings({
                        editorWordWrap: DEFAULT_UNIFIED_SETTINGS.editorWordWrap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorWordWrap}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorWordWrap: Boolean(checked) })
                  }
                  aria-label="Wrap workspace editor lines"
                />
              }
            />

            <SettingsRow
              title="Editor sticky scroll"
              description="Pin the current scope header while you scroll through a file."
              resetAction={
                settings.editorStickyScroll !== DEFAULT_UNIFIED_SETTINGS.editorStickyScroll ? (
                  <SettingResetButton
                    label="editor sticky scroll"
                    onClick={() =>
                      updateSettings({
                        editorStickyScroll: DEFAULT_UNIFIED_SETTINGS.editorStickyScroll,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorStickyScroll}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorStickyScroll: Boolean(checked) })
                  }
                  aria-label="Enable editor sticky scroll"
                />
              }
            />

            <SettingsRow
              title="Editor minimap"
              description="Show a code minimap in the workspace editor."
              resetAction={
                settings.editorMinimap !== DEFAULT_UNIFIED_SETTINGS.editorMinimap ? (
                  <SettingResetButton
                    label="editor minimap"
                    onClick={() =>
                      updateSettings({
                        editorMinimap: DEFAULT_UNIFIED_SETTINGS.editorMinimap,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorMinimap}
                  onCheckedChange={(checked) => updateSettings({ editorMinimap: Boolean(checked) })}
                  aria-label="Show editor minimap"
                />
              }
            />

            <SettingsRow
              title="Editor whitespace"
              description="Render whitespace characters in the workspace editor."
              resetAction={
                settings.editorRenderWhitespace !==
                DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace ? (
                  <SettingResetButton
                    label="editor whitespace"
                    onClick={() =>
                      updateSettings({
                        editorRenderWhitespace: DEFAULT_UNIFIED_SETTINGS.editorRenderWhitespace,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.editorRenderWhitespace}
                  onCheckedChange={(checked) =>
                    updateSettings({ editorRenderWhitespace: Boolean(checked) })
                  }
                  aria-label="Render editor whitespace"
                />
              }
            />

            <SettingsRow
              title="Editor line numbers"
              description="Choose how line numbers appear in the workspace editor."
              resetAction={
                settings.editorLineNumbers !== DEFAULT_UNIFIED_SETTINGS.editorLineNumbers ? (
                  <SettingResetButton
                    label="editor line numbers"
                    onClick={() =>
                      updateSettings({
                        editorLineNumbers: DEFAULT_UNIFIED_SETTINGS.editorLineNumbers,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.editorLineNumbers}
                  onValueChange={(value) => {
                    if (value === "off" || value === "on" || value === "relative") {
                      updateSettings({ editorLineNumbers: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-40" aria-label="Editor line numbers">
                    <SelectValue>{settings.editorLineNumbers}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="on">
                      On
                    </SelectItem>
                    <SelectItem hideIndicator value="relative">
                      Relative
                    </SelectItem>
                    <SelectItem hideIndicator value="off">
                      Off
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            <SettingsRow
              title="Language server tools"
              description="Install the core bundle, browse a curated LSP catalog, and keep custom servers inside ace."
              status={
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" size="sm">
                    {lspCoreTools.filter((tool) => tool.installed).length}/{lspCoreTools.length}{" "}
                    core
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {lspCatalogTools.filter((tool) => tool.installed).length}/
                    {lspCatalogTools.length} curated
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {lspCustomTools.length} custom
                  </Badge>
                  {lspToolsError ? <div className="text-destructive">{lspToolsError}</div> : null}
                </div>
              }
              control={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refreshLspToolsStatus}
                    disabled={isInstallingLspTools}
                  >
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => installLspToolsFromSettings(lspCoreToolsInstalled)}
                    disabled={isInstallingLspTools}
                  >
                    {isInstallingLspTools
                      ? "Installing..."
                      : lspCoreToolsInstalled
                        ? "Reinstall core"
                        : "Install core"}
                  </Button>
                </div>
              }
            >
              <div className="mt-3 space-y-3">
                <div className="rounded-[var(--panel-radius)] border border-border/50 bg-background/35 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <div className="text-[13px] font-medium text-foreground/90">
                        Curated marketplace for ace’s editor runtime
                      </div>
                      <div className="max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
                        Built-ins cover the common web stack. The catalog below adds popular config,
                        schema, shell, infra, and component-file servers without leaving the app.
                      </div>
                    </div>
                    {lspToolsStatus?.installDir ? (
                      <div className="rounded-[var(--control-radius)] border border-border/50 bg-background/55 px-3 py-2 text-[11px] text-muted-foreground">
                        Install root
                        <div className="mt-1 font-mono text-[10px] text-foreground">
                          {lspToolsStatus.installDir}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-3 rounded-[var(--panel-radius)] border border-border/50 bg-background/35 p-3">
                  <Input
                    value={lspCatalogQuery}
                    onChange={(event) => setLspCatalogQuery(event.target.value)}
                    placeholder="Search languages, frameworks, commands, or packages"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={lspCatalogCategory === "all" ? "default" : "outline"}
                      onClick={() => setLspCatalogCategory("all")}
                    >
                      All
                    </Button>
                    {lspCatalogCategories.map((category) => (
                      <Button
                        key={category}
                        size="sm"
                        variant={lspCatalogCategory === category ? "default" : "outline"}
                        onClick={() => setLspCatalogCategory(category)}
                      >
                        {LSP_CATEGORY_LABELS[category]}
                      </Button>
                    ))}
                  </div>
                </div>

                {filteredLspCatalogTools.length === 0 ? (
                  <div className="rounded-[var(--panel-radius)] border border-dashed border-border/60 px-4 py-6 text-center text-[13px] text-muted-foreground">
                    No curated language servers match this filter.
                  </div>
                ) : (
                  <div className="grid gap-2 lg:grid-cols-2">
                    {filteredLspCatalogTools.map((tool) => (
                      <div
                        key={tool.id}
                        className={cn(
                          "rounded-[var(--panel-radius)] border p-3 transition-colors",
                          tool.installed
                            ? "border-emerald-500/25 bg-emerald-500/[0.05]"
                            : "border-border/50 bg-background/35",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-[13px] font-medium text-foreground/90">
                                {tool.label}
                              </div>
                              <Badge variant={getLspToolStatusBadgeVariant(tool)} size="sm">
                                {tool.installed
                                  ? tool.version
                                    ? `Installed · ${tool.version}`
                                    : "Installed"
                                  : "Not installed"}
                              </Badge>
                              <Badge variant="outline" size="sm">
                                {tool.builtin ? "Core" : LSP_CATEGORY_LABELS[tool.category]}
                              </Badge>
                              <Badge variant="outline" size="sm">
                                {LSP_INSTALLER_LABELS[tool.installer]}
                              </Badge>
                            </div>
                            <p className="text-[12px] leading-relaxed text-muted-foreground">
                              {tool.description}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={tool.installed ? "outline" : "default"}
                            onClick={() => installCatalogTool(tool)}
                            disabled={isInstallingCustomLsp}
                          >
                            {isInstallingCustomLsp && lspInstallTargetId === tool.id
                              ? "Installing..."
                              : tool.installed
                                ? "Reinstall"
                                : "Install"}
                          </Button>
                        </div>

                        <div className="mt-3 space-y-2.5 text-[11px] text-muted-foreground">
                          <div className="space-y-1">
                            <div className="uppercase tracking-[0.14em] text-muted-foreground/70">
                              Package
                            </div>
                            <div className="font-mono text-foreground">{tool.packageName}</div>
                          </div>
                          <div className="space-y-1">
                            <div className="uppercase tracking-[0.14em] text-muted-foreground/70">
                              Command
                            </div>
                            <div className="font-mono text-foreground">
                              {tool.command}
                              {tool.args.length > 0 ? ` ${tool.args.join(" ")}` : ""}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {tool.languageIds.map((languageId) => (
                              <Badge key={`${tool.id}-${languageId}`} variant="secondary" size="sm">
                                {languageId}
                              </Badge>
                            ))}
                            {tool.fileExtensions.map((extension) => (
                              <Badge key={`${tool.id}-${extension}`} variant="outline" size="sm">
                                {extension}
                              </Badge>
                            ))}
                            {tool.fileNames.map((fileName) => (
                              <Badge key={`${tool.id}-${fileName}`} variant="outline" size="sm">
                                {fileName}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {lspCustomTools.length > 0 ? (
                  <div className="space-y-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Custom servers
                    </div>
                    <div className="grid gap-2 lg:grid-cols-2">
                      {lspCustomTools.map((tool) => (
                        <div
                          key={tool.id}
                          className="rounded-[var(--panel-radius)] border border-border/50 bg-background/35 p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-[13px] font-medium text-foreground/90">
                                  {tool.label}
                                </div>
                                <Badge variant={getLspToolStatusBadgeVariant(tool)} size="sm">
                                  {tool.installed ? "Installed" : "Missing"}
                                </Badge>
                                <Badge variant="outline" size="sm">
                                  {LSP_INSTALLER_LABELS[tool.installer]}
                                </Badge>
                              </div>
                              <p className="text-[12px] leading-relaxed text-muted-foreground">
                                {tool.description}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => seedCustomLspForm(tool)}
                            >
                              Edit copy
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-[var(--panel-radius)] border border-border/50 bg-background/35 p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-[13px] font-medium text-foreground/90">
                        Custom package
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        Register npm or uv-backed language servers with explicit file associations.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsLspCustomFormOpen((open) => !open)}
                    >
                      {isLspCustomFormOpen ? "Hide form" : "Install custom LSP"}
                    </Button>
                  </div>

                  {isLspCustomFormOpen ? (
                    <div className="mt-3 space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {(["npm", "uv-tool", "go-install", "rustup"] as const).map((installer) => (
                          <Button
                            key={installer}
                            size="sm"
                            variant={lspCustomForm.installer === installer ? "default" : "outline"}
                            onClick={() =>
                              setLspCustomForm((current) => ({
                                ...current,
                                installer,
                              }))
                            }
                          >
                            {LSP_INSTALLER_LABELS[installer]}
                          </Button>
                        ))}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          value={lspCustomForm.packageName}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              packageName: event.target.value,
                            }))
                          }
                          placeholder={
                            lspCustomForm.installer === "uv-tool"
                              ? "Package name (e.g. basedpyright)"
                              : lspCustomForm.installer === "go-install"
                                ? "Package name (e.g. golang.org/x/tools/gopls)"
                                : lspCustomForm.installer === "rustup"
                                  ? "Package name (e.g. rust-analyzer)"
                                  : "Package name (e.g. @tailwindcss/language-server)"
                          }
                        />
                        <Input
                          value={lspCustomForm.command}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              command: event.target.value,
                            }))
                          }
                          placeholder="Command"
                        />
                        <Input
                          value={lspCustomForm.label}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              label: event.target.value,
                            }))
                          }
                          placeholder="Display label"
                        />
                        <Input
                          value={lspCustomForm.args}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              args: event.target.value,
                            }))
                          }
                          placeholder="Args (comma-separated, optional)"
                        />
                        <Input
                          value={lspCustomForm.languageIds}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              languageIds: event.target.value,
                            }))
                          }
                          placeholder="Language IDs (comma-separated)"
                        />
                        <Input
                          value={lspCustomForm.fileExtensions}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              fileExtensions: event.target.value,
                            }))
                          }
                          placeholder="File extensions (comma-separated)"
                        />
                        <Input
                          value={lspCustomForm.fileNames}
                          onChange={(event) =>
                            setLspCustomForm((current) => ({
                              ...current,
                              fileNames: event.target.value,
                            }))
                          }
                          placeholder="File names (comma-separated, optional)"
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={submitCustomLspInstall}
                          disabled={isInstallingCustomLsp}
                        >
                          {isInstallingCustomLsp && lspInstallTargetId === "custom-form"
                            ? "Installing..."
                            : "Install custom LSP"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}

      {isBrowserPage ? (
        <SettingsSection title="In-app browser">
          <SettingsRow
            title="Search engine"
            description="Choose the default engine for new-tab search, address-bar suggestions, and quick browser entry."
            resetAction={
              settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ? (
                <SettingResetButton
                  label="browser search engine"
                  onClick={() =>
                    updateSettings({
                      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
                    })
                  }
                />
              ) : null
            }
          >
            <div className="mt-3 flex flex-wrap gap-2">
              {BROWSER_SEARCH_ENGINE_OPTIONS.map((engine) => (
                <Button
                  key={engine.value}
                  size="sm"
                  variant={settings.browserSearchEngine === engine.value ? "default" : "outline"}
                  onClick={() => updateSettings({ browserSearchEngine: engine.value })}
                >
                  {engine.label}
                </Button>
              ))}
            </div>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      {isModelsPage ? (
        <SettingsSection title="Text generation">
          <SettingsRow
            title="Text generation model"
            description="Configure an override for generated commit messages, PR titles, and similar Git text. Leave it unchanged to fall back to the current chat model."
            resetAction={
              isGitWritingModelDirty ? (
                <SettingResetButton
                  label="text generation model"
                  onClick={() =>
                    updateSettings({
                      textGenerationModelSelection:
                        DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  provider={textGenProvider}
                  model={textGenModel}
                  lockedProvider={null}
                  providers={serverProviders}
                  modelOptionsByProvider={gitModelOptionsByProvider}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onProviderModelChange={(provider, model) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: { provider, model },
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
                <TraitsPicker
                  provider={textGenProvider}
                  models={
                    serverProviders.find((provider) => provider.provider === textGenProvider)
                      ?.models ?? []
                  }
                  model={textGenModel}
                  prompt=""
                  onPromptChange={() => {}}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: buildProviderModelSelection(
                            textGenProvider,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        serverProviders,
                      ),
                    });
                  }}
                />
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {isProvidersPage ? (
        <>
          <SettingsSection title="CLI lifecycle">
            <SettingsRow
              title="Max open CLIs"
              description="Soft cap on concurrently open provider CLI sessions. If all open sessions are busy, ace can burst above this cap and trim later when sessions go idle."
              resetAction={
                settings.providerCliMaxOpen !== DEFAULT_UNIFIED_SETTINGS.providerCliMaxOpen ? (
                  <SettingResetButton
                    label="provider CLI max open"
                    onClick={() =>
                      updateSettings({
                        providerCliMaxOpen: DEFAULT_UNIFIED_SETTINGS.providerCliMaxOpen,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-full sm:w-28"
                    aria-label="Maximum open provider CLI sessions"
                    value={String(settings.providerCliMaxOpen)}
                    onChange={(event) => {
                      const nextValue = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(nextValue)) {
                        return;
                      }
                      updateSettings({
                        providerCliMaxOpen: Math.max(1, nextValue),
                      });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">sessions</span>
                </div>
              }
            />

            <SettingsRow
              title="Idle timeout"
              description="Close unused provider CLI sessions when idle longer than this timeout since the most recent assistant completion."
              resetAction={
                settings.providerCliIdleTtlSeconds !==
                DEFAULT_UNIFIED_SETTINGS.providerCliIdleTtlSeconds ? (
                  <SettingResetButton
                    label="provider CLI idle timeout"
                    onClick={() =>
                      updateSettings({
                        providerCliIdleTtlSeconds:
                          DEFAULT_UNIFIED_SETTINGS.providerCliIdleTtlSeconds,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-full sm:w-28"
                    aria-label="Provider CLI idle timeout in seconds"
                    value={String(settings.providerCliIdleTtlSeconds)}
                    onChange={(event) => {
                      const nextValue = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(nextValue)) {
                        return;
                      }
                      updateSettings({
                        providerCliIdleTtlSeconds: Math.max(1, nextValue),
                      });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">sec</span>
                </div>
              }
            />
          </SettingsSection>

          <ProviderSettingsSection
            addCustomModel={addCustomModel}
            codexHomePath={codexHomePath}
            customModelErrorByProvider={customModelErrorByProvider}
            customModelInputByProvider={customModelInputByProvider}
            isRefreshingProviders={isRefreshingProviders}
            lastCheckedAt={lastCheckedAt}
            modelListRefs={modelListRefs}
            openProviderDetails={openProviderDetails}
            providerCards={providerCards}
            refreshProviders={refreshProviders}
            removeCustomModel={removeCustomModel}
            setCustomModelErrorByProvider={setCustomModelErrorByProvider}
            setCustomModelInputByProvider={setCustomModelInputByProvider}
            setOpenProviderDetails={setOpenProviderDetails}
            settings={settings}
            textGenProvider={textGenProvider}
            updateSettings={updateSettings}
          />
        </>
      ) : null}

      {isAdvancedPage ? (
        <>
          <SettingsSection title="Git credentials">
            <SettingsRow
              title="SSH key passphrase"
              description="Use this passphrase once when automated git SSH fetch or push needs to unlock a private key."
              resetAction={
                settings.gitSshKeyPassphrase !== DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase ? (
                  <SettingResetButton
                    label="Git SSH key passphrase"
                    onClick={() =>
                      updateSettings({
                        gitSshKeyPassphrase: DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase,
                      })
                    }
                  />
                ) : null
              }
              status={settings.gitSshKeyPassphrase.trim().length > 0 ? "Configured" : "Not set"}
              control={
                <Input
                  type="password"
                  className="w-full sm:w-72"
                  value={settings.gitSshKeyPassphrase}
                  onChange={(event) => {
                    updateSettings({ gitSshKeyPassphrase: event.target.value });
                  }}
                  placeholder="Optional private key passphrase"
                  aria-label="Git SSH key passphrase"
                  autoComplete="off"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Performance">
            <SettingsRow
              title="Thread cache budget"
              description="Limit how much memory hydrated thread history can use before least-recently-used threads are evicted."
              resetAction={
                settings.threadHydrationCacheMemoryMb !==
                DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb ? (
                  <SettingResetButton
                    label="thread cache budget"
                    onClick={() =>
                      updateSettings({
                        threadHydrationCacheMemoryMb:
                          DEFAULT_UNIFIED_SETTINGS.threadHydrationCacheMemoryMb,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-full sm:w-28"
                    aria-label="Thread cache memory budget in megabytes"
                    value={String(settings.threadHydrationCacheMemoryMb)}
                    onChange={(event) => {
                      const nextValue = Number.parseInt(event.target.value, 10);
                      if (!Number.isFinite(nextValue)) {
                        return;
                      }
                      updateSettings({
                        threadHydrationCacheMemoryMb: Math.max(1, nextValue),
                      });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">MB</span>
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection title="Keybindings">
            <SettingsRow
              title="Keybindings"
              description="Configure shortcuts directly here. Press keys to record bindings, then save or revert."
            >
              <div className="mt-3">
                <KeybindingsSettingsEditor />
              </div>
            </SettingsRow>
          </SettingsSection>
        </>
      ) : null}

      {isAboutPage ? (
        <SettingsSection title="Application">
          {isElectron ? (
            <>
              <AboutVersionSection />
              <AboutCliInstallSection />
            </>
          ) : (
            <SettingsRow
              title={<AboutVersionTitle />}
              description="Current version of the application."
            />
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function GeneralSettingsPanel() {
  return <SettingsPanel page="general" />;
}

export function ChatSettingsPanel() {
  return <SettingsPanel page="chat" />;
}

export function EditorSettingsPanel() {
  return <SettingsPanel page="editor" />;
}

export function BrowserSettingsPanel() {
  return <SettingsPanel page="browser" />;
}

export function ModelsSettingsPanel() {
  return <SettingsPanel page="models" />;
}

export function ProvidersSettingsPanel() {
  return <SettingsPanel page="providers" />;
}

export function AdvancedSettingsPanel() {
  return <SettingsPanel page="advanced" />;
}

export function AboutSettingsPanel() {
  return <SettingsPanel page="about" />;
}

type ArchivedProjectGroup = {
  readonly project: Project;
  readonly threads: Thread[];
  readonly totalThreadCount: number;
  readonly sortKey: string;
};

function getArchiveSortKey(project: Project, threads: readonly Thread[]) {
  const projectKey = project.archivedAt ?? project.updatedAt ?? project.createdAt ?? "";
  const threadKey = threads[0]?.archivedAt ?? threads[0]?.updatedAt ?? threads[0]?.createdAt ?? "";
  return projectKey > threadKey ? projectKey : threadKey;
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function ArchivedThreadsPanel() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const threadCountByProjectId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const archivedGroups = useMemo(() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    return [...projectById.values()]
      .map<ArchivedProjectGroup>((project) => {
        const archivedThreads = threads
          .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
          .toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          });

        return {
          project,
          threads: archivedThreads,
          totalThreadCount: threadCountByProjectId.get(project.id) ?? 0,
          sortKey: getArchiveSortKey(project, archivedThreads),
        };
      })
      .filter((group) => group.project.archivedAt !== null || group.threads.length > 0)
      .toSorted(
        (left, right) =>
          right.sortKey.localeCompare(left.sortKey) ||
          left.project.name.localeCompare(right.project.name) ||
          right.project.id.localeCompare(left.project.id),
      );
  }, [projects, threadCountByProjectId, threads]);
  const [openGroupIds, setOpenGroupIds] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOpenGroupIds((current) => {
      const next: Record<string, boolean> = {};
      for (const group of archivedGroups) {
        next[group.project.id] = current[group.project.id] ?? true;
      }
      return next;
    });
  }, [archivedGroups]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadId);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to unarchive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadId);
      }
    },
    [confirmAndDeleteThread, unarchiveThread],
  );
  const restoreProject = useCallback(async (projectId: Project["id"]) => {
    const api = readNativeApi();
    if (!api) {
      throw new Error("Project restore is unavailable.");
    }
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId,
      archivedAt: null,
    });
  }, []);
  const hasArchivedItems = archivedGroups.length > 0;
  const allGroupsExpanded = archivedGroups.every(
    (group) => openGroupIds[group.project.id] !== false,
  );
  const setAllGroupsOpen = useCallback(
    (open: boolean) => {
      const next: Record<string, boolean> = {};
      for (const group of archivedGroups) {
        next[group.project.id] = open;
      }
      setOpenGroupIds(next);
    },
    [archivedGroups],
  );
  const setGroupOpen = useCallback((projectId: Project["id"], open: boolean) => {
    setOpenGroupIds((current) => ({ ...current, [projectId]: open }));
  }, []);

  return (
    <SettingsPageContainer>
      {!hasArchivedItems ? (
        <SettingsSection title="Archived">
          <Empty className="min-h-88">
            <EmptyMedia variant="icon">
              <ArchiveIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No archived items</EmptyTitle>
              <EmptyDescription>Archived projects and threads will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="By project"
          icon={<ArchiveIcon />}
          headerAction={
            archivedGroups.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setAllGroupsOpen(!allGroupsExpanded)}
              >
                {allGroupsExpanded ? "Collapse all" : "Expand all"}
              </Button>
            ) : null
          }
        >
          {archivedGroups.map((group) => {
            const project = group.project;
            const isOpen = openGroupIds[project.id] !== false;
            const archivedItemCount = group.threads.length + (project.archivedAt === null ? 0 : 1);

            return (
              <div key={project.id} className="border-t border-border/45 first:border-t-0">
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors duration-150 hover:bg-accent/25 sm:px-4"
                  aria-expanded={isOpen}
                  onClick={() => setGroupOpen(project.id, !isOpen)}
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground/55 transition-transform duration-200",
                      !isOpen && "-rotate-90",
                    )}
                    aria-hidden="true"
                  />
                  <ProjectAvatar
                    project={project}
                    className="size-8 rounded-[var(--control-radius)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-[13px] font-medium text-foreground/90">
                        {project.name}
                      </h3>
                      {project.archivedAt !== null ? (
                        <span className="shrink-0 rounded-[var(--control-radius)] border border-border/50 bg-background/35 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Project
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatCountLabel(archivedItemCount, "archived item")} {"\u00b7 "}
                      {formatCountLabel(group.threads.length, "thread")}
                    </p>
                  </div>
                </button>

                <Collapsible open={isOpen} onOpenChange={(open) => setGroupOpen(project.id, open)}>
                  <CollapsibleContent>
                    <div className="border-t border-border/45 bg-background/25">
                      {project.archivedAt !== null ? (
                        <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/50 bg-card/40 text-muted-foreground">
                              <ArchiveIcon className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <h4 className="truncate text-[13px] font-medium text-foreground/90">
                                Project archive
                              </h4>
                              <p className="truncate text-xs text-muted-foreground">
                                Archived{" "}
                                {formatRelativeTimeLabel(
                                  project.archivedAt ??
                                    project.updatedAt ??
                                    project.createdAt ??
                                    "",
                                )}
                                {" \u00b7 "}
                                {formatCountLabel(group.totalThreadCount, "total thread")}
                              </p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                            onClick={() =>
                              void restoreProject(project.id).catch((error) => {
                                toastManager.add({
                                  type: "error",
                                  title: "Failed to restore project",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                });
                              })
                            }
                          >
                            <ArchiveX className="size-3.5" />
                            <span>Restore</span>
                          </Button>
                        </div>
                      ) : null}

                      {group.threads.map((thread) => (
                        <div
                          key={thread.id}
                          className={cn(
                            "flex items-center justify-between gap-3 border-t border-border/45 px-3 py-3 sm:px-4",
                            project.archivedAt === null && "first:border-t-0",
                          )}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void handleArchivedThreadContextMenu(thread.id, {
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            <h4 className="truncate text-[13px] font-medium text-foreground/90">
                              {thread.title}
                            </h4>
                            <p className="text-xs text-muted-foreground">
                              Archived{" "}
                              {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                              {" \u00b7 Created "}
                              {formatRelativeTimeLabel(thread.createdAt)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                            onClick={() =>
                              void unarchiveThread(thread.id).catch((error) => {
                                toastManager.add({
                                  type: "error",
                                  title: "Failed to unarchive thread",
                                  description:
                                    error instanceof Error ? error.message : "An error occurred.",
                                });
                              })
                            }
                          >
                            <ArchiveX className="size-3.5" />
                            <span>Unarchive</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            );
          })}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
