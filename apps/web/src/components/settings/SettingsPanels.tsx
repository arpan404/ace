import {
  ArchiveIcon,
  ArchiveX,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ClockIcon,
  DownloadIcon,
  FolderGit2Icon,
  GitForkIcon,
  HardDriveIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconCheck,
  IconPalette,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import type {
  DesktopCliInstallState,
  ProviderKind,
  ProjectId,
  ProjectScript,
  ServerInstallLspToolInput,
  ServerLspToolInstaller,
  ServerLspToolStatus,
  ServerLspToolsStatus,
  ThreadId,
} from "@ace/contracts";
import {
  BROWSER_MAX_MOUNTED_INSTANCES_LIMIT,
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
import { buildProviderModelSelection, formatProviderModelDisplayName } from "@ace/shared/model";
import * as Equal from "effect/Equal";
import { APP_VERSION } from "../../branding";
import {
  DESKTOP_UPDATE_FALLBACK_DOWNLOAD_URL,
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../lib/desktopUpdate";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSidebarTranslucent } from "../../hooks/useSidebarTranslucent";
import { useThemePreset } from "../../hooks/useThemePreset";
import { THEME_PRESET_OPTIONS, type ThemePresetId } from "../../themePresets";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEffectEvent } from "~/hooks/useEffectEvent";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { hasLiveTurn } from "../../session-logic";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import {
  setDesktopCliInstallStateQueryData,
  useDesktopCliInstallState,
} from "../../lib/desktopCliInstallReactQuery";
import { gitBranchesQueryOptions, gitWorktreeStatsQueryOptions } from "../../lib/gitReactQuery";
import {
  DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH,
  formatProjectScriptEnv,
  nextProjectScriptId,
  normalizeProjectScriptEnvFilePath,
  parseProjectScriptEnv,
  setupProjectScript,
} from "../../projectScripts";
import {
  getCustomModelOptionsByProvider,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ensureNativeApi, readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  formatWorktreePathForDisplay,
  getWorktreeLinkedThreadIds,
  isWorktreeThreadSessionActive,
  normalizeWorktreePath,
} from "../../worktreeCleanup";
import { BROWSER_SEARCH_ENGINE_OPTIONS } from "../../lib/browser/types";
import { cn, newCommandId } from "../../lib/utils";
import { resolveConnectionForProjectId } from "../../lib/connectionRouting";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectAvatar } from "../ProjectAvatar";
import type { Project, Thread } from "../../types";
import { ProviderSettingsSection, type ProviderCard } from "./ProviderSettingsSection";
import { PROVIDER_SETTINGS } from "./settingsProviderConfig";
import { KeybindingsSettingsEditor } from "./KeybindingsSettingsEditor";
import {
  SETTINGS_FIELD_CLASS,
  SETTINGS_LIST_ROW_BUTTON_CLASS,
  SETTINGS_SELECT_TRIGGER_CLASS,
} from "./settingsUi";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  SETTINGS_LIST_ROW_CLASS_NAME,
  SETTINGS_ROW_INSET_CLASS_NAME,
  SettingsChoiceGroup,
  SettingsInput,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSegmentedControl,
  SettingResetButton,
} from "./SettingsPanelPrimitives";
import { getProviderSummary, getProviderVersionLabel } from "./providerSummary";
import { applyProvidersUpdated, useServerProviders } from "../../rpc/serverState";

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

const WORKSPACE_SUMMARY_GENERATION_MODE_OPTIONS = [
  {
    value: "manual",
    label: "Manual",
    description: "Only generate when you click the summary action.",
  },
  {
    value: "auto",
    label: "Automatic",
    description: "Refresh after each completed diff capture.",
  },
] as const;

const UI_FONT_FAMILY_VALUE_SET = new Set(UI_FONT_FAMILY_OPTIONS.map((o) => o.value));
const UI_MONO_FONT_VALUE_SET = new Set(UI_MONO_FONT_OPTIONS.map((o) => o.value));
const UI_FONT_SIZE_VALUE_SET = new Set(UI_FONT_SIZE_OPTIONS.map((o) => o.value));
const UI_LETTER_SPACING_VALUE_SET = new Set(UI_LETTER_SPACING_OPTIONS.map((o) => o.value));

function parseDelimitedValues(input: string): string[] {
  const values = new Set<string>();
  for (const value of input.split(",")) {
    const normalizedValue = value.trim();
    if (normalizedValue.length > 0) {
      values.add(normalizedValue);
    }
  }
  return Array.from(values);
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
const EMPTY_LSP_CUSTOM_FORM = {
  installer: "npm" as ServerLspToolInstaller,
  packageName: "",
  command: "",
  label: "",
  args: "",
  languageIds: "",
  fileExtensions: "",
  fileNames: "",
};

type SettingsNotificationState = {
  notificationPermission: AgentAttentionNotificationPermission;
  isUpdatingNotificationPermission: boolean;
};

type SettingsNotificationAction =
  | { type: "set-permission"; notificationPermission: AgentAttentionNotificationPermission }
  | { type: "set-updating"; isUpdatingNotificationPermission: boolean };

function settingsNotificationStateReducer(
  state: SettingsNotificationState,
  action: SettingsNotificationAction,
): SettingsNotificationState {
  switch (action.type) {
    case "set-permission":
      return state.notificationPermission === action.notificationPermission
        ? state
        : { ...state, notificationPermission: action.notificationPermission };
    case "set-updating":
      return state.isUpdatingNotificationPermission === action.isUpdatingNotificationPermission
        ? state
        : { ...state, isUpdatingNotificationPermission: action.isUpdatingNotificationPermission };
  }
}

type SettingsLspState = {
  lspToolsStatus: ServerLspToolsStatus | null;
  lspToolsError: string | null;
  isInstallingLspTools: boolean;
  lspCatalogQuery: string;
  lspCatalogCategory: "all" | ServerLspToolStatus["category"];
  isInstallingCustomLsp: boolean;
  lspInstallTargetId: string | null;
  isLspCustomFormOpen: boolean;
  lspCustomForm: typeof EMPTY_LSP_CUSTOM_FORM;
};

type SettingsLspAction =
  | { type: "set-tools-status"; lspToolsStatus: ServerLspToolsStatus | null }
  | { type: "set-tools-error"; lspToolsError: string | null }
  | { type: "set-installing-tools"; isInstallingLspTools: boolean }
  | { type: "set-catalog-query"; lspCatalogQuery: string }
  | { type: "set-catalog-category"; lspCatalogCategory: "all" | ServerLspToolStatus["category"] }
  | { type: "set-installing-custom"; isInstallingCustomLsp: boolean }
  | { type: "set-install-target-id"; lspInstallTargetId: string | null }
  | { type: "set-custom-form-open"; isLspCustomFormOpen: boolean }
  | { type: "set-custom-form"; lspCustomForm: typeof EMPTY_LSP_CUSTOM_FORM }
  | { type: "update-custom-form"; lspCustomForm: Partial<typeof EMPTY_LSP_CUSTOM_FORM> };

function settingsLspStateReducer(
  state: SettingsLspState,
  action: SettingsLspAction,
): SettingsLspState {
  switch (action.type) {
    case "set-tools-status":
      return state.lspToolsStatus === action.lspToolsStatus
        ? state
        : { ...state, lspToolsStatus: action.lspToolsStatus };
    case "set-tools-error":
      return state.lspToolsError === action.lspToolsError
        ? state
        : { ...state, lspToolsError: action.lspToolsError };
    case "set-installing-tools":
      return state.isInstallingLspTools === action.isInstallingLspTools
        ? state
        : { ...state, isInstallingLspTools: action.isInstallingLspTools };
    case "set-catalog-query":
      return state.lspCatalogQuery === action.lspCatalogQuery
        ? state
        : { ...state, lspCatalogQuery: action.lspCatalogQuery };
    case "set-catalog-category":
      return state.lspCatalogCategory === action.lspCatalogCategory
        ? state
        : { ...state, lspCatalogCategory: action.lspCatalogCategory };
    case "set-installing-custom":
      return state.isInstallingCustomLsp === action.isInstallingCustomLsp
        ? state
        : { ...state, isInstallingCustomLsp: action.isInstallingCustomLsp };
    case "set-install-target-id":
      return state.lspInstallTargetId === action.lspInstallTargetId
        ? state
        : { ...state, lspInstallTargetId: action.lspInstallTargetId };
    case "set-custom-form-open":
      return state.isLspCustomFormOpen === action.isLspCustomFormOpen
        ? state
        : { ...state, isLspCustomFormOpen: action.isLspCustomFormOpen };
    case "set-custom-form":
      return state.lspCustomForm === action.lspCustomForm
        ? state
        : { ...state, lspCustomForm: action.lspCustomForm };
    case "update-custom-form":
      return { ...state, lspCustomForm: { ...state.lspCustomForm, ...action.lspCustomForm } };
  }
}

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

function parseLspToolVersionFromSpecifier(
  tool: Pick<ServerLspToolStatus, "installer" | "packageName">,
  specifier: string,
): string | null {
  const trimmed = specifier.trim();
  if (tool.installer === "uv-tool") {
    const prefix = `${tool.packageName}==`;
    return trimmed.startsWith(prefix) && trimmed.length > prefix.length
      ? trimmed.slice(prefix.length)
      : null;
  }

  const prefix = `${tool.packageName}@`;
  return trimmed.startsWith(prefix) && trimmed.length > prefix.length
    ? trimmed.slice(prefix.length)
    : null;
}

function resolveLspToolVersionLabel(
  tool: Pick<ServerLspToolStatus, "installer" | "installPackages" | "packageName" | "version">,
): string {
  if (tool.version) {
    return tool.version;
  }
  for (const specifier of tool.installPackages) {
    const version = parseLspToolVersionFromSpecifier(tool, specifier);
    if (version) {
      return version;
    }
  }
  return "Latest";
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

function resolveCombinedNotificationPermission(
  rendererPermission: AgentAttentionNotificationPermission,
  desktopPermission: AgentAttentionNotificationPermission,
): AgentAttentionNotificationPermission {
  if (rendererPermission === "granted" || rendererPermission === "denied") {
    return rendererPermission;
  }
  if (desktopPermission !== "unsupported") {
    return desktopPermission;
  }
  return rendererPermission;
}

async function readSettingsNotificationPermission(): Promise<AgentAttentionNotificationPermission> {
  const rendererPermission = readAgentAttentionNotificationPermission();
  if (
    !isElectron ||
    typeof window === "undefined" ||
    typeof window.desktopBridge?.getNotificationPermission !== "function"
  ) {
    return rendererPermission;
  }

  try {
    const desktopPermission = await window.desktopBridge.getNotificationPermission();
    return resolveCombinedNotificationPermission(rendererPermission, desktopPermission);
  } catch {
    return rendererPermission;
  }
}

async function requestSettingsNotificationPermission(): Promise<AgentAttentionNotificationPermission> {
  const rendererPermission = await requestAgentAttentionNotificationPermission();
  if (
    !isElectron ||
    rendererPermission === "granted" ||
    rendererPermission === "denied" ||
    typeof window === "undefined" ||
    typeof window.desktopBridge?.requestNotificationPermission !== "function"
  ) {
    return rendererPermission;
  }

  try {
    const desktopPermission = await window.desktopBridge.requestNotificationPermission();
    return resolveCombinedNotificationPermission(rendererPermission, desktopPermission);
  } catch {
    return rendererPermission;
  }
}

function sendNotificationProbe() {
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
}

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

const ONE_CLICK_UPGRADE_PROVIDERS = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "githubCopilot",
  "cursor",
  "pi",
  "gemini",
  "opencode",
]);

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();
  const runningAgentCount = useStore(
    (store) =>
      store.threads.filter((thread) => hasLiveTurn(thread.latestTurn, thread.session)).length,
  );

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = () => {
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

    if (action === "external-download") {
      const api = readNativeApi() ?? ensureNativeApi();
      void api.shell.openExternal(DESKTOP_UPDATE_FALLBACK_DOWNLOAD_URL).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not open download page",
          description: error instanceof Error ? error.message : "Unable to open GitHub Releases.",
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
  };

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: "Download",
    install: "Install",
    "external-download": "Download latest",
  };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    installing: "Restarting…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available for desktop, web UI, server daemon, and CLI."
      : action === "external-download"
        ? "Automatic update could not finish. Download the latest desktop build and install it manually."
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
      <code className="text-xs font-medium text-muted-foreground">ace</code>
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

  const handleInstallCli = () => {
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
  };

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
          <code className="block break-all font-mono text-xs text-foreground">
            {cliInstallState.commandPath}
          </code>
        </div>
      ) : null}
      {cliInstallState.pathTargets.length > 0 ? (
        <div className="space-y-0.5">
          <span className="block">PATH targets</span>
          {cliInstallState.pathTargets.map((target) => (
            <code key={target} className="block break-all font-mono text-xs text-foreground">
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

type SettingsPanelPage =
  | "general"
  | "appearance"
  | "browser"
  | "chat"
  | "editor"
  | "providers"
  | "advanced"
  | "about";

type ThemeModeValue = "system" | "light" | "dark";

const THEME_MODE_CARDS: { value: ThemeModeValue; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** A miniature window mock (sidebar rail + content skeleton) in a fixed light/dark palette,
 *  used inside the theme-mode preview cards — independent of the currently active theme. */
function ThemeMockPanel({ scheme }: { scheme: "light" | "dark" }) {
  const isDark = scheme === "dark";
  const surface = isDark ? "#18181b" : "#f4f4f5";
  const rail = isDark ? "#0f0f11" : "#e8e8eb";
  const card = isDark ? "#26262a" : "#ffffff";
  const line = isDark ? "#37373c" : "#dcdce0";
  return (
    <div className="flex h-full w-full" style={{ backgroundColor: surface }}>
      <div className="flex h-full w-[30%] flex-col gap-1 p-1.5" style={{ backgroundColor: rail }}>
        <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#4f8cff" }} />
        <div className="h-1 w-4/5 rounded-full" style={{ backgroundColor: line }} />
        <div className="h-1 w-3/5 rounded-full" style={{ backgroundColor: line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: line }} />
        <div className="h-4 w-full rounded-sm" style={{ backgroundColor: card }} />
        <div className="h-1 w-4/5 rounded-full" style={{ backgroundColor: line }} />
      </div>
    </div>
  );
}

function ThemeModeCards({
  value,
  onChange,
}: {
  value: ThemeModeValue;
  onChange: (value: ThemeModeValue) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Theme mode" className="grid grid-cols-3 gap-3">
      {THEME_MODE_CARDS.map((mode) => {
        const active = value === mode.value;
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${mode.label} theme`}
            onClick={() => onChange(mode.value)}
            className="group/mode flex flex-col items-center gap-2 outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-ring/40"
          >
            <div
              className={cn(
                "w-full overflow-hidden rounded-[0.9rem] border transition-all",
                active
                  ? "border-primary ring-2 ring-primary/25"
                  : "border-border/60 group-hover/mode:border-border",
              )}
            >
              <div className="flex aspect-[16/10] w-full">
                {mode.value === "system" ? (
                  <>
                    <div className="h-full w-1/2">
                      <ThemeMockPanel scheme="light" />
                    </div>
                    <div className="h-full w-1/2">
                      <ThemeMockPanel scheme="dark" />
                    </div>
                  </>
                ) : (
                  <ThemeMockPanel scheme={mode.value} />
                )}
              </div>
            </div>
            <span
              className={cn(
                "text-[13px] transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground group-hover/mode:text-foreground/80",
              )}
            >
              {mode.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const THEME_PRESET_FAMILIES: { id: "signature" | "editor" | "accent"; label: string }[] = [
  { id: "signature", label: "Signature" },
  { id: "editor", label: "Editor themes" },
  { id: "accent", label: "Accents" },
];

/** Interactive palette grid for the color preset — each preset is a clickable chip showing
 *  its surface gradient + accent, grouped by family, with the active one marked. */
function ThemePresetGrid({
  value,
  onChange,
}: {
  value: ThemePresetId;
  onChange: (id: ThemePresetId) => void;
}) {
  return (
    <div className="space-y-3.5">
      {THEME_PRESET_FAMILIES.map((family) => {
        const presets = THEME_PRESET_OPTIONS.filter((preset) => preset.family === family.id);
        if (presets.length === 0) {
          return null;
        }
        return (
          <div key={family.id} className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/45">
              {family.label}
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {presets.map((preset) => {
                const active = value === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={`${preset.label} palette`}
                    title={preset.description}
                    onClick={() => onChange(preset.id)}
                    className={cn(
                      "group/preset flex items-center gap-2 rounded-[0.85rem] border p-1.5 text-left transition-[border-color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      active
                        ? "border-primary/60 bg-primary/[0.05] ring-1 ring-primary/15"
                        : "border-border/50 hover:border-border hover:bg-accent/40",
                    )}
                  >
                    <span
                      aria-hidden
                      className="flex size-7 shrink-0 items-center justify-center rounded-[0.6rem] border border-black/10 shadow-sm dark:border-white/10"
                      style={{
                        background: `linear-gradient(135deg, ${preset.preview.panel}, ${preset.preview.panelDeep})`,
                      }}
                    >
                      <IconPalette
                        className="size-3.5"
                        stroke={2}
                        style={{ color: preset.preview.accent }}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                      {preset.label}
                    </span>
                    {active ? (
                      <IconCheck className="size-3.5 shrink-0 text-primary" stroke={2.5} />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useSettingsPanelComponent({ page }: { page: SettingsPanelPage }) {
  const { theme, setTheme } = useTheme();
  const { preset, setPreset } = useThemePreset();
  const { translucent: sidebarTranslucent, setTranslucent: setSidebarTranslucent } =
    useSidebarTranslucent();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [notificationState, dispatchNotificationState] = useReducer(
    settingsNotificationStateReducer,
    undefined,
    (): SettingsNotificationState => ({
      notificationPermission: isElectron ? "default" : readAgentAttentionNotificationPermission(),
      isUpdatingNotificationPermission: false,
    }),
  );
  const { notificationPermission, isUpdatingNotificationPermission } = notificationState;
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
    githubCopilot: "",
    cursor: "",
    pi: "",
    gemini: "",
    opencode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [upgradingRuntimeKey, setUpgradingRuntimeKey] = useState<string | null>(null);
  const [lspState, dispatchLspState] = useReducer(settingsLspStateReducer, {
    lspToolsStatus: null,
    lspToolsError: null,
    isInstallingLspTools: false,
    lspCatalogQuery: "",
    lspCatalogCategory: "all",
    isInstallingCustomLsp: false,
    lspInstallTargetId: null,
    isLspCustomFormOpen: false,
    lspCustomForm: EMPTY_LSP_CUSTOM_FORM,
  });
  const {
    lspToolsStatus,
    lspToolsError,
    isInstallingLspTools,
    lspCatalogQuery,
    lspCatalogCategory,
    isInstallingCustomLsp,
    lspInstallTargetId,
    isLspCustomFormOpen,
    lspCustomForm,
  } = lspState;
  const refreshingRef = useRef(false);
  const modelListRefs = useRef<Partial<Record<ProviderKind, HTMLDivElement | null>>>({});
  const refreshProviders = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureNativeApi()
      .server.refreshProviders({ checkCliUpdates: true })
      .then(applyProvidersUpdated)
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  };
  const upgradeProviderCli = (provider: ProviderKind, runtimeId: string) => {
    if (upgradingRuntimeKey !== null) return;
    const runtimeKey = `${provider}:${runtimeId}`;
    setUpgradingRuntimeKey(runtimeKey);
    const providerLabel =
      PROVIDER_SETTINGS.find((entry) => entry.provider === provider)?.title ?? provider;
    const toastId = toastManager.add({
      type: "loading",
      title: `Updating ${providerLabel}`,
      description: "Updating to the latest CLI version.",
    });
    void ensureNativeApi()
      .server.upgradeProviderCli({ provider, runtimeId })
      .then((payload) => {
        applyProvidersUpdated(payload);
        toastManager.update(toastId, {
          type: "success",
          title: `${providerLabel} updated`,
          description: "Provider status was refreshed.",
        });
      })
      .catch((error: unknown) => {
        toastManager.update(toastId, {
          type: "error",
          title: `Unable to update ${providerLabel}`,
          description: getErrorMessage(error, "CLI update failed."),
        });
      })
      .finally(() => {
        setUpgradingRuntimeKey(null);
      });
  };
  const isUpgradingRuntime = (provider: ProviderKind, runtimeId: string) =>
    upgradingRuntimeKey === `${provider}:${runtimeId}`;
  const canOpenNotificationSystemSettings = isElectron && resolveNotificationSettingsUrl() !== null;
  const hasAnyAgentAttentionNotificationsEnabled =
    settings.notifyOnAgentCompletion ||
    settings.notifyOnApprovalRequired ||
    settings.notifyOnUserInputRequired;
  const setAgentAttentionNotificationToggles = (enabled: boolean) => {
    updateSettings(buildAgentAttentionNotificationSettingsPatch(enabled));
  };
  const notificationPermissionDescription = (() => {
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
  })();

  const refreshNotificationPermission = () => {
    if (typeof window === "undefined") {
      return Promise.resolve<AgentAttentionNotificationPermission>("unsupported");
    }
    return readSettingsNotificationPermission().then((permission) => {
      dispatchNotificationState({ type: "set-permission", notificationPermission: permission });
      return permission;
    });
  };

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    const syncPermission = () => {
      void readSettingsNotificationPermission()
        .then((permission) => {
          dispatchNotificationState({ type: "set-permission", notificationPermission: permission });
        })
        .catch(() => {
          dispatchNotificationState({
            type: "set-permission",
            notificationPermission: "unsupported",
          });
        });
    };
    syncPermission();
    document.addEventListener("visibilitychange", syncPermission);
    window.addEventListener("focus", syncPermission);
    return () => {
      document.removeEventListener("visibilitychange", syncPermission);
      window.removeEventListener("focus", syncPermission);
    };
  }, []);

  const handleSendNotificationTest = () => {
    dispatchNotificationState({ type: "set-updating", isUpdatingNotificationPermission: true });
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
        dispatchNotificationState({
          type: "set-updating",
          isUpdatingNotificationPermission: false,
        });
      });
  };

  const enableNotifications = (enabledKeys?: readonly AgentAttentionNotificationSettingKey[]) => {
    dispatchNotificationState({ type: "set-updating", isUpdatingNotificationPermission: true });

    void requestSettingsNotificationPermission()
      .then(async (permission) => {
        dispatchNotificationState({ type: "set-permission", notificationPermission: permission });
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
        dispatchNotificationState({
          type: "set-updating",
          isUpdatingNotificationPermission: false,
        });
      });
  };

  const disableNotifications = () => {
    setAgentAttentionNotificationToggles(false);
  };

  const openNotificationSettings = () => {
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
    dispatchNotificationState({ type: "set-updating", isUpdatingNotificationPermission: true });
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
        dispatchNotificationState({
          type: "set-updating",
          isUpdatingNotificationPermission: false,
        });
      });
  };

  const handleNotificationToggleChange = (
    key: AgentAttentionNotificationSettingKey,
    checked: boolean,
  ) => {
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
  };

  const serverProviders = useServerProviders();
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

  const providerCards: ProviderCard[] = PROVIDER_SETTINGS.map((providerSettings) => {
    const liveProviderSnapshots = serverProviders.filter(
      (candidate) => candidate.provider === providerSettings.provider,
    );
    const liveProvider =
      liveProviderSnapshots.find((candidate) => candidate.isDefaultProviderInstance === true) ??
      liveProviderSnapshots.find((candidate) => !candidate.providerInstanceId) ??
      liveProviderSnapshots[0];
    const providerConfig = settings.providers[providerSettings.provider];
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
      canUpgradeCli: ONE_CLICK_UPGRADE_PROVIDERS.has(providerSettings.provider),
      homePathKey: providerSettings.homePathKey,
      homePlaceholder: providerSettings.homePlaceholder,
      homeDescription: providerSettings.homeDescription,
      cliUrlPlaceholder: providerSettings.cliUrlPlaceholder,
      cliUrlDescription: providerSettings.cliUrlDescription,
      models,
      providerSnapshots: liveProviderSnapshots,
      runtimes: liveProvider?.runtimes,
      statusStyle: PROVIDER_STATUS_STYLES[statusKey],
      summary,
      latestVersionLabel: getProviderVersionLabel(liveProvider?.latestVersion),
      updateStatus: liveProvider?.updateStatus,
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
  const isAppearancePage = page === "appearance";
  const isBrowserPage = page === "browser";
  const isChatPage = page === "chat";
  const isEditorPage = page === "editor";
  const isProvidersPage = page === "providers";
  const isAdvancedPage = page === "advanced";
  const isAboutPage = page === "about";
  const lspTools = lspToolsStatus?.tools ?? EMPTY_LSP_TOOL_LIST;
  const lspCoreTools = lspTools.filter((tool) => tool.builtin);
  const lspCatalogTools = lspTools.filter((tool) => tool.source !== "custom");
  const lspCustomTools = lspTools.filter((tool) => tool.source === "custom");
  const lspCoreToolsInstalled =
    lspCoreTools.length > 0 && lspCoreTools.every((tool) => tool.installed);
  const filteredLspCatalogTools = (() => {
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
  })();
  const lspCatalogCategories = (() => {
    const categories = new Set<ServerLspToolStatus["category"]>();
    for (const tool of lspCatalogTools) {
      if (tool.category !== "custom") {
        categories.add(tool.category);
      }
    }
    return Array.from(categories);
  })();
  const lspCatalogCategoryLabel =
    lspCatalogCategory === "all" ? "All categories" : LSP_CATEGORY_LABELS[lspCatalogCategory];

  const refreshLspToolsStatus = useStableCallback(() => {
    void ensureNativeApi()
      .server.getLspToolsStatus()
      .then((status) => {
        dispatchLspState({ type: "set-tools-status", lspToolsStatus: status });
        dispatchLspState({ type: "set-tools-error", lspToolsError: null });
      })
      .catch((error: unknown) => {
        dispatchLspState({
          type: "set-tools-error",
          lspToolsError: getErrorMessage(error, "Unable to load LSP tool status."),
        });
      });
  });

  const installLspToolsFromSettings = (reinstall: boolean) => {
    dispatchLspState({ type: "set-installing-tools", isInstallingLspTools: true });
    dispatchLspState({ type: "set-tools-error", lspToolsError: null });
    void ensureNativeApi()
      .server.installLspTools({ reinstall })
      .then((status) => {
        dispatchLspState({ type: "set-tools-status", lspToolsStatus: status });
        toastManager.add({
          type: "success",
          title: "Language server tools are ready.",
        });
      })
      .catch((error: unknown) => {
        dispatchLspState({
          type: "set-tools-error",
          lspToolsError: getErrorMessage(error, "Unable to install LSP tools."),
        });
      })
      .finally(() =>
        dispatchLspState({ type: "set-installing-tools", isInstallingLspTools: false }),
      );
  };

  const installCustomLspTool = (
    input: ServerInstallLspToolInput,
    installTargetId: string | null = null,
  ) => {
    dispatchLspState({ type: "set-installing-custom", isInstallingCustomLsp: true });
    dispatchLspState({ type: "set-install-target-id", lspInstallTargetId: installTargetId });
    dispatchLspState({ type: "set-tools-error", lspToolsError: null });
    void ensureNativeApi()
      .server.installLspTool(input)
      .then((status) => {
        dispatchLspState({ type: "set-tools-status", lspToolsStatus: status });
        toastManager.add({
          type: "success",
          title: `Installed ${input.label}.`,
        });
      })
      .catch((error: unknown) => {
        dispatchLspState({
          type: "set-tools-error",
          lspToolsError: getErrorMessage(error, "Unable to install custom language server."),
        });
      })
      .finally(() => {
        dispatchLspState({ type: "set-installing-custom", isInstallingCustomLsp: false });
        dispatchLspState({ type: "set-install-target-id", lspInstallTargetId: null });
      });
  };

  const installCatalogTool = (tool: ServerLspToolStatus) => {
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
  };

  const uninstallCatalogTool = (tool: ServerLspToolStatus) => {
    dispatchLspState({ type: "set-installing-custom", isInstallingCustomLsp: true });
    dispatchLspState({ type: "set-install-target-id", lspInstallTargetId: tool.id });
    dispatchLspState({ type: "set-tools-error", lspToolsError: null });
    void ensureNativeApi()
      .server.uninstallLspTool({ id: tool.id })
      .then((status) => {
        dispatchLspState({ type: "set-tools-status", lspToolsStatus: status });
        toastManager.add({
          type: "success",
          title: `Uninstalled ${tool.label}.`,
        });
      })
      .catch((error: unknown) => {
        dispatchLspState({
          type: "set-tools-error",
          lspToolsError: getErrorMessage(error, "Unable to uninstall language server."),
        });
      })
      .finally(() => {
        dispatchLspState({ type: "set-installing-custom", isInstallingCustomLsp: false });
        dispatchLspState({ type: "set-install-target-id", lspInstallTargetId: null });
      });
  };

  const seedCustomLspForm = (tool?: ServerLspToolStatus) => {
    if (tool) {
      dispatchLspState({
        type: "set-custom-form",
        lspCustomForm: {
          installer: tool.installer,
          packageName: tool.packageName,
          command: tool.command,
          label: tool.label,
          args: tool.args.join(", "),
          languageIds: tool.languageIds.join(", "),
          fileExtensions: tool.fileExtensions.join(", "),
          fileNames: tool.fileNames.join(", "),
        },
      });
    }
    dispatchLspState({ type: "set-custom-form-open", isLspCustomFormOpen: true });
  };

  const submitCustomLspInstall = () => {
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
      dispatchLspState({
        type: "set-tools-error",
        lspToolsError:
          "Package, command, label, language IDs, and at least one file extension or file name are required.",
      });
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
  };

  useEffect(() => {
    if (!isEditorPage || lspToolsStatus) return;
    refreshLspToolsStatus();
  }, [isEditorPage, lspToolsStatus, refreshLspToolsStatus]);

  return (
    <SettingsPageContainer>
      {isAppearancePage ? (
        <>
          <SettingsSection
            title="Theme"
            description="Pick light or dark and the accent palette — applies in both modes."
          >
            <div className="py-3">
              <ThemeModeCards value={theme} onChange={setTheme} />
            </div>

            <div className="py-3.5">
              <div className="mb-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-snug text-foreground">
                    Color preset
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
                    Palette for surfaces and accents. Applies in both light and dark.
                  </p>
                </div>
                {preset !== "ace" ? (
                  <SettingResetButton label="color preset" onClick={() => setPreset("ace")} />
                ) : null}
              </div>
              <ThemePresetGrid value={preset} onChange={setPreset} />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Surfaces"
            description="How the app's chrome renders behind your content."
          >
            <SettingsRow
              title="Translucent sidebar"
              description="Let the sidebar surface go semi-transparent so the desktop shows through."
              resetAction={
                sidebarTranslucent ? (
                  <SettingResetButton
                    label="translucent sidebar"
                    onClick={() => setSidebarTranslucent(false)}
                  />
                ) : null
              }
              control={
                <Switch
                  checked={sidebarTranslucent}
                  onCheckedChange={(checked) => setSidebarTranslucent(checked === true)}
                  aria-label="Translucent sidebar"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Typography" description="Fonts and sizing across the interface.">
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
                  <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS} aria-label="UI font">
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
                  <SelectTrigger
                    className={SETTINGS_SELECT_TRIGGER_CLASS}
                    aria-label="Monospace font"
                  >
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Text size"
                  value={settings.uiFontSizeScale}
                  onValueChange={(value) => updateSettings({ uiFontSizeScale: value })}
                  options={UI_FONT_SIZE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Letter spacing"
                  value={settings.uiLetterSpacing}
                  onValueChange={(value) => updateSettings({ uiLetterSpacing: value })}
                  options={UI_LETTER_SPACING_OPTIONS}
                />
              }
            />
          </SettingsSection>
        </>
      ) : null}

      {isGeneralPage ? (
        <>
          <SettingsSection title="General">
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Timestamp format"
                  value={settings.timestampFormat}
                  onValueChange={(value) => updateSettings({ timestampFormat: value })}
                  options={[
                    { value: "locale", label: "System" },
                    { value: "12-hour", label: "12h" },
                    { value: "24-hour", label: "24h" },
                  ]}
                />
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Default thread mode"
                  value={settings.defaultThreadEnvMode}
                  onValueChange={(value) => updateSettings({ defaultThreadEnvMode: value })}
                  options={[
                    { value: "local", label: "Local" },
                    { value: "worktree", label: "New worktree" },
                  ]}
                />
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Workspace editor opening mode"
                  value={settings.workspaceEditorOpenMode}
                  onValueChange={(value) => updateSettings({ workspaceEditorOpenMode: value })}
                  options={[
                    { value: "split", label: "Split view" },
                    { value: "full", label: "Full editor" },
                  ]}
                />
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
                <SettingsInput
                  className="w-full"
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

            <SettingsRow
              title="Hide completed work details"
              description="After an assistant turn finishes, hide tool and thinking rows and keep only the worked-for time."
              resetAction={
                settings.hideCompletedWorkMessages !==
                DEFAULT_UNIFIED_SETTINGS.hideCompletedWorkMessages ? (
                  <SettingResetButton
                    label="completed work details"
                    onClick={() =>
                      updateSettings({
                        hideCompletedWorkMessages:
                          DEFAULT_UNIFIED_SETTINGS.hideCompletedWorkMessages,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.hideCompletedWorkMessages}
                  onCheckedChange={(checked) =>
                    updateSettings({ hideCompletedWorkMessages: Boolean(checked) })
                  }
                  aria-label="Hide completed work details"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Reliability">
            <SettingsRow
              title="Recovery UX"
              description="Show connection health, diagnostics actions, stuck-turn hints, and connection recovery toasts."
              resetAction={
                settings.reliabilityUxEnabled !== DEFAULT_UNIFIED_SETTINGS.reliabilityUxEnabled ? (
                  <SettingResetButton
                    label="reliability recovery UX"
                    onClick={() =>
                      updateSettings({
                        reliabilityUxEnabled: DEFAULT_UNIFIED_SETTINGS.reliabilityUxEnabled,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.reliabilityUxEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ reliabilityUxEnabled: Boolean(checked) })
                  }
                  aria-label="Enable reliability recovery UX"
                />
              }
            />
          </SettingsSection>

          <SettingsSection title="Comments">
            <SettingsRow
              title="Accumulate comments"
              description="Hold browser and chat comments, then send them together with the next assistant request."
              resetAction={
                settings.commentSubmissionMode !==
                DEFAULT_UNIFIED_SETTINGS.commentSubmissionMode ? (
                  <SettingResetButton
                    label="comment submission"
                    onClick={() =>
                      updateSettings({
                        commentSubmissionMode: DEFAULT_UNIFIED_SETTINGS.commentSubmissionMode,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.commentSubmissionMode === "accumulate"}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      commentSubmissionMode: checked ? "accumulate" : "immediate",
                    })
                  }
                  aria-label="Accumulate comments"
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
          <SettingsSection
            title="Editor"
            description="Display and behavior of the built-in workspace editor."
          >
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
              layout="compact"
              control={
                <SettingsSegmentedControl
                  ariaLabel="Editor line numbers"
                  value={settings.editorLineNumbers}
                  onValueChange={(value) => updateSettings({ editorLineNumbers: value })}
                  options={[
                    { value: "on", label: "On" },
                    { value: "relative", label: "Relative" },
                    { value: "off", label: "Off" },
                  ]}
                />
              }
            />
          </SettingsSection>

          <SettingsSection
            title="Language servers"
            description="Install and manage language servers that power code intelligence."
          >
            <SettingsRow
              title="Language server tools"
              status={
                lspToolsError ? (
                  <span className="text-xs text-destructive">{lspToolsError}</span>
                ) : null
              }
              control={
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refreshLspToolsStatus}
                    disabled={isInstallingLspTools}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => installLspToolsFromSettings(lspCoreToolsInstalled)}
                    disabled={isInstallingLspTools}
                  >
                    <DownloadIcon className="size-3.5" />
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
                <div className="py-2">
                  <div className="flex flex-col gap-2">
                    <div className="relative min-w-0">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                      <SettingsInput
                        className="w-full pl-8"
                        value={lspCatalogQuery}
                        onChange={(event) =>
                          dispatchLspState({
                            type: "set-catalog-query",
                            lspCatalogQuery: event.target.value,
                          })
                        }
                        placeholder="Search language, package, command, or file type"
                      />
                    </div>
                    <Select
                      value={lspCatalogCategory}
                      onValueChange={(value) => {
                        if (value === null) {
                          return;
                        }
                        if (value === "all") {
                          dispatchLspState({
                            type: "set-catalog-category",
                            lspCatalogCategory: value,
                          });
                          return;
                        }
                        if (value !== "custom" && lspCatalogCategories.includes(value)) {
                          dispatchLspState({
                            type: "set-catalog-category",
                            lspCatalogCategory: value,
                          });
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        className={SETTINGS_SELECT_TRIGGER_CLASS}
                        aria-label="Language server category filter"
                      >
                        <SelectValue>{lspCatalogCategoryLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="end" alignItemWithTrigger={false}>
                        <SelectItem hideIndicator value="all">
                          All categories
                        </SelectItem>
                        {lspCatalogCategories.map((category) => (
                          <SelectItem hideIndicator key={category} value={category}>
                            {LSP_CATEGORY_LABELS[category]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>

                <div>
                  {filteredLspCatalogTools.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground/62">
                      No language servers match this filter.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredLspCatalogTools.map((tool) => {
                        const isWorking = isInstallingCustomLsp && lspInstallTargetId === tool.id;
                        const versionLabel = resolveLspToolVersionLabel(tool);
                        return (
                          <div
                            key={tool.id}
                            className={cn(SETTINGS_LIST_ROW_CLASS_NAME, "flex items-center gap-3")}
                          >
                            <div className="flex min-w-0 flex-1 items-baseline gap-2">
                              <span className="truncate text-[13px] font-medium text-foreground">
                                {tool.label}
                              </span>
                              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                                {versionLabel}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant={tool.installed ? "outline" : "default"}
                              onClick={() =>
                                tool.installed
                                  ? uninstallCatalogTool(tool)
                                  : installCatalogTool(tool)
                              }
                              disabled={isInstallingCustomLsp}
                              className="shrink-0"
                            >
                              {isWorking
                                ? tool.installed
                                  ? "Uninstalling..."
                                  : "Installing..."
                                : tool.installed
                                  ? "Uninstall"
                                  : "Install"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {lspCustomTools.length > 0 ? (
                  <div>
                    <div className="py-2">
                      <div className="text-sm font-medium text-foreground/90">Custom servers</div>
                      <div className="text-xs text-muted-foreground/60">
                        Saved package definitions outside the curated catalog.
                      </div>
                    </div>
                    <div className="space-y-1">
                      {lspCustomTools.map((tool) => (
                        <div
                          key={tool.id}
                          className={cn(
                            SETTINGS_LIST_ROW_CLASS_NAME,
                            "flex items-start justify-between gap-3",
                          )}
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <div className="min-w-0 truncate text-[13px] font-medium text-foreground/92">
                                {tool.label}
                              </div>
                              <Badge variant={getLspToolStatusBadgeVariant(tool)} size="sm">
                                {tool.installed ? "Installed" : "Missing"}
                              </Badge>
                              <Badge variant="outline" size="sm">
                                {LSP_INSTALLER_LABELS[tool.installer]}
                              </Badge>
                            </div>
                            <p className="text-sm leading-relaxed text-muted-foreground/68">
                              {tool.description}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => seedCustomLspForm(tool)}
                          >
                            Edit copy
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div>
                  <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground/90">
                        Register custom server
                      </div>
                      <div className="text-xs text-muted-foreground/60">
                        Add package-backed language servers with explicit file associations.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        dispatchLspState({
                          type: "set-custom-form-open",
                          isLspCustomFormOpen: !isLspCustomFormOpen,
                        })
                      }
                    >
                      <WrenchIcon className="size-3.5" />
                      {isLspCustomFormOpen ? "Hide form" : "Install custom"}
                    </Button>
                  </div>

                  {isLspCustomFormOpen ? (
                    <div className="space-y-3 py-3">
                      <div className="flex max-w-full gap-1 overflow-x-auto py-1">
                        {(["npm", "uv-tool", "go-install", "rustup"] as const).map((installer) => (
                          <Button
                            key={installer}
                            size="sm"
                            variant={lspCustomForm.installer === installer ? "default" : "ghost"}
                            onClick={() =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { installer },
                              })
                            }
                            className="shrink-0"
                          >
                            {LSP_INSTALLER_LABELS[installer]}
                          </Button>
                        ))}
                      </div>
                      <div className="flex flex-col gap-3">
                        <label
                          htmlFor="lsp-custom-package"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          Package
                          <SettingsInput
                            id="lsp-custom-package"
                            value={lspCustomForm.packageName}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { packageName: event.target.value },
                              })
                            }
                            placeholder={
                              lspCustomForm.installer === "uv-tool"
                                ? "basedpyright"
                                : lspCustomForm.installer === "go-install"
                                  ? "golang.org/x/tools/gopls"
                                  : lspCustomForm.installer === "rustup"
                                    ? "rust-analyzer"
                                    : "@tailwindcss/language-server"
                            }
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-command"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          Command
                          <SettingsInput
                            id="lsp-custom-command"
                            value={lspCustomForm.command}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { command: event.target.value },
                              })
                            }
                            placeholder="language-server-command"
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-label"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          Display label
                          <SettingsInput
                            id="lsp-custom-label"
                            value={lspCustomForm.label}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { label: event.target.value },
                              })
                            }
                            placeholder="Tailwind CSS"
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-args"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          Args
                          <SettingsInput
                            id="lsp-custom-args"
                            value={lspCustomForm.args}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { args: event.target.value },
                              })
                            }
                            placeholder="comma-separated, optional"
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-language-ids"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          Language IDs
                          <SettingsInput
                            id="lsp-custom-language-ids"
                            value={lspCustomForm.languageIds}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { languageIds: event.target.value },
                              })
                            }
                            placeholder="typescript, javascript"
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-file-extensions"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72"
                        >
                          File extensions
                          <SettingsInput
                            id="lsp-custom-file-extensions"
                            value={lspCustomForm.fileExtensions}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { fileExtensions: event.target.value },
                              })
                            }
                            placeholder=".ts, .tsx"
                          />
                        </label>
                        <label
                          htmlFor="lsp-custom-file-names"
                          className="grid gap-1 text-xs font-medium text-muted-foreground/72 sm:col-span-2"
                        >
                          File names
                          <SettingsInput
                            id="lsp-custom-file-names"
                            value={lspCustomForm.fileNames}
                            onChange={(event) =>
                              dispatchLspState({
                                type: "update-custom-form",
                                lspCustomForm: { fileNames: event.target.value },
                              })
                            }
                            placeholder="comma-separated, optional"
                          />
                        </label>
                      </div>
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={submitCustomLspInstall}
                          disabled={isInstallingCustomLsp}
                        >
                          <DownloadIcon className="size-3.5" />
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
            <SettingsChoiceGroup
              label="Search engine"
              className="w-full"
              options={BROWSER_SEARCH_ENGINE_OPTIONS}
              value={settings.browserSearchEngine}
              onValueChange={(browserSearchEngine) => updateSettings({ browserSearchEngine })}
            />
          </SettingsRow>
          <SettingsRow
            title="Max mounted browsers"
            description="Control how many thread browser surfaces stay mounted for fast switching. Higher values preserve more browser state but use more memory."
            resetAction={
              settings.browserMaxMountedInstances !==
              DEFAULT_UNIFIED_SETTINGS.browserMaxMountedInstances ? (
                <SettingResetButton
                  label="max mounted browsers"
                  onClick={() =>
                    updateSettings({
                      browserMaxMountedInstances:
                        DEFAULT_UNIFIED_SETTINGS.browserMaxMountedInstances,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <SettingsInput
                  type="number"
                  min={1}
                  max={BROWSER_MAX_MOUNTED_INSTANCES_LIMIT}
                  step={1}
                  className="w-full"
                  aria-label="Maximum mounted browser instances"
                  value={String(settings.browserMaxMountedInstances)}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    if (!Number.isFinite(nextValue)) {
                      return;
                    }
                    updateSettings({
                      browserMaxMountedInstances: Math.min(
                        BROWSER_MAX_MOUNTED_INSTANCES_LIMIT,
                        Math.max(1, nextValue),
                      ),
                    });
                  }}
                />
                <span className="text-xs text-muted-foreground">
                  {settings.browserMaxMountedInstances === 1 ? "browser" : "browsers"}
                </span>
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {isProvidersPage ? (
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
                  providerInstanceId={textGenerationModelSelection.providerInstanceId}
                  model={textGenModel}
                  lockedProvider={null}
                  providers={serverProviders}
                  modelOptionsByProvider={gitModelOptionsByProvider}
                  providerInstancesByProvider={{
                    codex: settings.providers.codex.instances,
                    claudeAgent: settings.providers.claudeAgent.instances,
                    githubCopilot: settings.providers.githubCopilot.instances,
                    cursor: settings.providers.cursor.instances,
                    pi: settings.providers.pi.instances,
                    gemini: settings.providers.gemini.instances,
                    opencode: settings.providers.opencode.instances,
                  }}
                  triggerSurface="settings"
                  onProviderModelChange={(provider, model, providerInstanceId) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: {
                            provider,
                            ...(providerInstanceId && providerInstanceId !== "default"
                              ? { providerInstanceId }
                              : {}),
                            model,
                          },
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
                  triggerSurface="settings"
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: buildProviderModelSelection(
                            textGenProvider,
                            textGenModel,
                            nextOptions,
                            textGenerationModelSelection.providerInstanceId,
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

          <SettingsRow
            title="Summary generation"
            description="Choose whether code summaries refresh automatically after each completed diff or only when requested manually."
            resetAction={
              settings.workspaceSummaryGenerationMode !==
              DEFAULT_UNIFIED_SETTINGS.workspaceSummaryGenerationMode ? (
                <SettingResetButton
                  label="summary generation"
                  onClick={() =>
                    updateSettings({
                      workspaceSummaryGenerationMode:
                        DEFAULT_UNIFIED_SETTINGS.workspaceSummaryGenerationMode,
                    })
                  }
                />
              ) : null
            }
            layout="compact"
            control={
              <SettingsSegmentedControl
                ariaLabel="Summary generation"
                value={settings.workspaceSummaryGenerationMode}
                onValueChange={(workspaceSummaryGenerationMode) =>
                  updateSettings({ workspaceSummaryGenerationMode })
                }
                options={WORKSPACE_SUMMARY_GENERATION_MODE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
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
                  <SettingsInput
                    type="number"
                    min={1}
                    step={1}
                    className="w-full"
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
                  <SettingsInput
                    type="number"
                    min={1}
                    step={1}
                    className="w-full"
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
            customModelErrorByProvider={customModelErrorByProvider}
            customModelInputByProvider={customModelInputByProvider}
            isRefreshingProviders={isRefreshingProviders}
            isUpgradingRuntime={isUpgradingRuntime}
            lastCheckedAt={lastCheckedAt}
            modelListRefs={modelListRefs}
            providerCards={providerCards}
            refreshProviders={refreshProviders}
            setCustomModelErrorByProvider={setCustomModelErrorByProvider}
            setCustomModelInputByProvider={setCustomModelInputByProvider}
            settings={settings}
            textGenProvider={textGenProvider}
            upgradeProviderCli={upgradeProviderCli}
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
                <SettingsInput
                  type="password"
                  className="w-full"
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
                  <SettingsInput
                    type="number"
                    min={1}
                    step={1}
                    className="w-full"
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

function SettingsPanel(props: { page: SettingsPanelPage }) {
  return useSettingsPanelComponent(props);
}

export function GeneralSettingsPanel() {
  return <SettingsPanel page="general" />;
}

export function AppearanceSettingsPanel() {
  return <SettingsPanel page="appearance" />;
}

export function BrowserSettingsPanel() {
  return <SettingsPanel page="browser" />;
}

export function ChatSettingsPanel() {
  return <SettingsPanel page="chat" />;
}

export function EditorSettingsPanel() {
  return <SettingsPanel page="editor" />;
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

type EnvironmentWorktreeEntry = {
  readonly path: string;
  readonly displayName: string;
  readonly branchNames: readonly string[];
  readonly relatedThreads: readonly Thread[];
  readonly activeThread: Thread | null;
};

type EnvironmentWorktreeStats = {
  readonly exists: boolean;
  readonly lastModifiedAt: string | null;
  readonly sizeBytes: number;
};

type EnvironmentProjectFilter = "all" | "with-worktrees" | "inactive" | "setup";
type EnvironmentProjectSort = "name" | "inactive" | "worktrees" | "storage";
type EnvironmentWorktreeFilter = "all" | "inactive" | "active" | "linked";
type EnvironmentWorktreeSort = "recent" | "oldest" | "name" | "storage";
type EnvironmentWorktreeCleanupAge = "all" | "7d" | "30d" | "90d";

type EnvironmentProjectMetrics = {
  readonly hasSetup: boolean;
  readonly storageBytes: number;
  readonly worktreeCount: number;
};

const ENVIRONMENT_PROJECT_FILTER_LABELS = {
  all: "All projects",
  inactive: "Inactive",
  setup: "Setup saved",
  "with-worktrees": "Has worktrees",
} satisfies Record<EnvironmentProjectFilter, string>;

const ENVIRONMENT_PROJECT_SORT_LABELS = {
  inactive: "Inactive first",
  name: "Name",
  storage: "Storage",
  worktrees: "Worktrees",
} satisfies Record<EnvironmentProjectSort, string>;

const ENVIRONMENT_WORKTREE_FILTER_LABELS = {
  active: "Active",
  all: "All",
  inactive: "Inactive",
  linked: "Has chats",
} satisfies Record<EnvironmentWorktreeFilter, string>;

const ENVIRONMENT_WORKTREE_SORT_LABELS = {
  name: "Name",
  oldest: "Oldest",
  recent: "Recent",
  storage: "Storage",
} satisfies Record<EnvironmentWorktreeSort, string>;

const ENVIRONMENT_WORKTREE_CLEANUP_AGE_LABELS = {
  "30d": "Older than 30 days",
  "7d": "Older than 7 days",
  "90d": "Older than 90 days",
  all: "All inactive",
} satisfies Record<EnvironmentWorktreeCleanupAge, string>;

const ENVIRONMENT_WORKTREE_CLEANUP_AGE_DAYS = {
  "30d": 30,
  "7d": 7,
  "90d": 90,
  all: null,
} satisfies Record<EnvironmentWorktreeCleanupAge, number | null>;

function getProjectWorktreePaths({
  branches,
  project,
}: {
  readonly branches: readonly { readonly worktreePath: string | null }[];
  readonly project: Project;
}): string[] {
  const projectCwd = normalizeWorktreePath(project.cwd);
  const paths = new Set<string>();

  for (const branch of branches) {
    const worktreePath = normalizeWorktreePath(branch.worktreePath);
    if (!worktreePath || worktreePath === projectCwd) {
      continue;
    }
    paths.add(worktreePath);
  }

  return Array.from(paths).toSorted((left, right) => left.localeCompare(right));
}

function formatStorageBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function shortenProjectPath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) {
    return normalized;
  }
  return `…/${parts.slice(-3).join("/")}`;
}

function getProjectPathDisambiguator(path: string): string | null {
  const aceMatch = path.match(/\/(ace-[a-z0-9]+)\//i);
  if (aceMatch?.[1]) {
    return aceMatch[1];
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2] ?? null;
  }
  return null;
}

function buildDuplicateProjectNameSet(projects: readonly Project[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  }
  const duplicateNames = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) {
      duplicateNames.add(name);
    }
  }
  return duplicateNames;
}

function formatEnvironmentProjectPathLine(project: Project): string {
  return shortenProjectPath(project.cwd);
}

function formatEnvironmentProjectDisplayName(
  project: Project,
  duplicateNames: ReadonlySet<string>,
): string {
  if (!duplicateNames.has(project.name)) {
    return project.name;
  }
  const disambiguator = getProjectPathDisambiguator(project.cwd);
  if (!disambiguator) {
    return project.name;
  }
  return `${project.name} · ${disambiguator}`;
}

function getWorktreeActivityTimeMs(
  worktree: EnvironmentWorktreeEntry,
  stats: EnvironmentWorktreeStats | undefined,
): number {
  const statTime = stats?.lastModifiedAt ? Date.parse(stats.lastModifiedAt) : Number.NaN;
  if (Number.isFinite(statTime)) {
    return statTime;
  }
  let latestThreadTime = 0;
  for (const thread of worktree.relatedThreads) {
    if (!thread.updatedAt) {
      continue;
    }
    const threadTime = Date.parse(thread.updatedAt);
    if (Number.isFinite(threadTime)) {
      latestThreadTime = Math.max(latestThreadTime, threadTime);
    }
  }
  return latestThreadTime;
}

function formatWorktreeActivityLabel(
  worktree: EnvironmentWorktreeEntry,
  stats: EnvironmentWorktreeStats | undefined,
): string {
  const activityTimeMs = getWorktreeActivityTimeMs(worktree, stats);
  if (activityTimeMs <= 0) {
    return "No activity";
  }
  return formatRelativeTimeLabel(new Date(activityTimeMs).toISOString());
}

function isWorktreeOlderThan(
  worktree: EnvironmentWorktreeEntry,
  stats: EnvironmentWorktreeStats | undefined,
  age: EnvironmentWorktreeCleanupAge,
  now: number,
): boolean {
  const days = ENVIRONMENT_WORKTREE_CLEANUP_AGE_DAYS[age];
  if (days === null) {
    return true;
  }
  const activityTimeMs = getWorktreeActivityTimeMs(worktree, stats);
  return activityTimeMs > 0 && activityTimeMs <= now - days * 24 * 60 * 60_000;
}

async function restoreArchivedProject(projectId: Project["id"]) {
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
}

function getEnvironmentWorktreeEntries({
  branches,
  project,
  threads,
}: {
  readonly branches: readonly { readonly name: string; readonly worktreePath: string | null }[];
  readonly project: Project;
  readonly threads: readonly Thread[];
}): EnvironmentWorktreeEntry[] {
  const projectCwd = normalizeWorktreePath(project.cwd);
  const branchNamesByPath = new Map<string, Set<string>>();

  for (const branch of branches) {
    const worktreePath = normalizeWorktreePath(branch.worktreePath);
    if (!worktreePath || worktreePath === projectCwd) {
      continue;
    }
    let branchNames = branchNamesByPath.get(worktreePath);
    if (!branchNames) {
      branchNames = new Set<string>();
      branchNamesByPath.set(worktreePath, branchNames);
    }
    branchNames.add(branch.name);
  }

  return Array.from(branchNamesByPath.entries())
    .map(([path, branchNames]) => {
      const relatedThreadIds = new Set(getWorktreeLinkedThreadIds(threads, path));
      const relatedThreads = threads.filter((thread) => relatedThreadIds.has(thread.id));
      return {
        path,
        displayName: formatWorktreePathForDisplay(path),
        branchNames: Array.from(branchNames).toSorted((left, right) => left.localeCompare(right)),
        relatedThreads,
        activeThread: relatedThreads.find(isWorktreeThreadSessionActive) ?? null,
      };
    })
    .toSorted(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) || left.path.localeCompare(right.path),
    );
}

interface ProjectWorktreeSetupEditorState {
  readonly command: string;
  readonly envText: string;
  readonly envFilePath: string;
  readonly validationError: string | null;
  readonly saving: boolean;
}

type ProjectWorktreeSetupEditorAction =
  | { readonly type: "set-command"; readonly command: string }
  | { readonly type: "set-env-text"; readonly envText: string }
  | { readonly type: "set-env-file-path"; readonly envFilePath: string }
  | { readonly type: "set-validation-error"; readonly validationError: string | null }
  | { readonly type: "start-saving" }
  | { readonly type: "finish-saving" };

function projectWorktreeSetupEditorStateReducer(
  state: ProjectWorktreeSetupEditorState,
  action: ProjectWorktreeSetupEditorAction,
): ProjectWorktreeSetupEditorState {
  switch (action.type) {
    case "set-command":
      return state.command === action.command ? state : { ...state, command: action.command };
    case "set-env-text":
      return state.envText === action.envText ? state : { ...state, envText: action.envText };
    case "set-env-file-path":
      return state.envFilePath === action.envFilePath
        ? state
        : { ...state, envFilePath: action.envFilePath };
    case "set-validation-error":
      return state.validationError === action.validationError
        ? state
        : { ...state, validationError: action.validationError };
    case "start-saving":
      return state.saving && state.validationError === null
        ? state
        : { ...state, saving: true, validationError: null };
    case "finish-saving":
      return state.saving ? { ...state, saving: false } : state;
  }
}

function ProjectWorktreeSetupEditor({ project }: { readonly project: Project }) {
  const setupScript = setupProjectScript(project.scripts);
  const commandInputId = useId();
  const envFileInputId = useId();
  const environmentInputId = useId();
  const [state, dispatchState] = useReducer(
    projectWorktreeSetupEditorStateReducer,
    undefined,
    (): ProjectWorktreeSetupEditorState => ({
      command: setupScript?.command ?? "",
      envText: formatProjectScriptEnv(setupScript?.env),
      envFilePath: setupScript?.envFilePath ?? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH,
      validationError: null,
      saving: false,
    }),
  );
  const { command, envText, envFilePath, validationError, saving } = state;

  const saveSetup = async () => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      dispatchState({
        type: "set-validation-error",
        validationError: "Setup command is required.",
      });
      return;
    }

    let parsedEnv: Record<string, string>;
    try {
      parsedEnv = parseProjectScriptEnv(envText);
    } catch (error) {
      dispatchState({
        type: "set-validation-error",
        validationError: error instanceof Error ? error.message : "Invalid environment variables.",
      });
      return;
    }
    let normalizedEnvFilePath: string;
    try {
      normalizedEnvFilePath = normalizeProjectScriptEnvFilePath(envFilePath);
    } catch (error) {
      dispatchState({
        type: "set-validation-error",
        validationError: error instanceof Error ? error.message : "Invalid environment file path.",
      });
      return;
    }

    dispatchState({ type: "start-saving" });
    try {
      const setupScriptId =
        setupScript?.id ??
        nextProjectScriptId(
          "Worktree setup",
          project.scripts.map((script) => script.id),
        );
      const nextSetupScript: ProjectScript = {
        id: setupScriptId,
        name: setupScript?.name ?? "Worktree setup",
        command: trimmedCommand,
        icon: setupScript?.icon ?? "configure",
        runOnWorktreeCreate: true,
        env: parsedEnv,
        envFilePath: normalizedEnvFilePath,
      };
      const nextScripts = setupScript
        ? project.scripts.map((script) =>
            script.id === setupScript.id
              ? nextSetupScript
              : script.runOnWorktreeCreate
                ? { ...script, runOnWorktreeCreate: false }
                : script,
          )
        : [
            ...project.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextSetupScript,
          ];

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: project.id,
        scripts: nextScripts,
      });
      toastManager.add({
        type: "success",
        title: "Saved worktree setup.",
      });
    } catch (error) {
      dispatchState({
        type: "set-validation-error",
        validationError: error instanceof Error ? error.message : "Failed to save setup command.",
      });
      dispatchState({ type: "finish-saving" });
      return;
    }
    dispatchState({ type: "finish-saving" });
  };

  const disableSetup = async () => {
    if (!setupScript) return;
    const api = readNativeApi();
    if (!api) {
      return;
    }
    dispatchState({ type: "start-saving" });
    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: project.id,
        scripts: project.scripts.map((script) =>
          script.id === setupScript.id ? { ...script, runOnWorktreeCreate: false } : script,
        ),
      });
    } catch (error) {
      dispatchState({
        type: "set-validation-error",
        validationError: error instanceof Error ? error.message : "Failed to disable setup.",
      });
      dispatchState({ type: "finish-saving" });
      return;
    }
    dispatchState({ type: "finish-saving" });
  };

  const hasEnv = Object.keys(setupScript?.env ?? {}).length > 0;
  const savedCommand = setupScript?.command ?? "";
  const savedEnvText = formatProjectScriptEnv(setupScript?.env);
  const savedEnvFilePath = setupScript?.envFilePath ?? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH;
  const setupHasUnsavedChanges =
    command !== savedCommand || envText !== savedEnvText || envFilePath !== savedEnvFilePath;
  const setupStatus = saving
    ? { label: "Saving", variant: "info" as const }
    : setupScript
      ? setupHasUnsavedChanges
        ? { label: "Unsaved changes", variant: "warning" as const }
        : { label: "Saved", variant: "success" as const }
      : { label: "Not saved", variant: "outline" as const };

  return (
    <div className={SETTINGS_ROW_INSET_CLASS_NAME}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {setupScript ? (
            <Badge variant="outline" size="sm" className="text-[10px]">
              automatic
            </Badge>
          ) : null}
          {hasEnv ? (
            <Badge variant="outline" size="sm" className="text-[10px]">
              {formatCountLabel(Object.keys(setupScript?.env ?? {}).length, "env var")}
            </Badge>
          ) : null}
          <Badge variant={setupStatus.variant} size="sm" className="text-[10px]">
            {setupStatus.label}
          </Badge>
        </div>
        <div className="flex shrink-0 gap-2">
          {setupScript ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={saving}
              onClick={disableSetup}
            >
              Disable
            </Button>
          ) : null}
          <Button
            type="button"
            variant={setupHasUnsavedChanges || !setupScript ? "outline" : "ghost"}
            size="xs"
            disabled={saving || (Boolean(setupScript) && !setupHasUnsavedChanges)}
            onClick={saveSetup}
          >
            {saving ? "Saving" : setupScript && !setupHasUnsavedChanges ? "Saved" : "Save setup"}
          </Button>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-4">
        <div className="space-y-1.5">
          <label htmlFor={commandInputId} className="text-xs font-medium text-muted-foreground">
            Command
          </label>
          <Textarea
            id={commandInputId}
            value={command}
            placeholder="bun install"
            size="sm"
            className="font-mono text-sm"
            onChange={(event) =>
              dispatchState({ type: "set-command", command: event.target.value })
            }
          />
        </div>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label htmlFor={envFileInputId} className="text-xs font-medium text-muted-foreground">
              Env file
            </label>
            <SettingsInput
              id={envFileInputId}
              value={envFilePath}
              placeholder=".env"
              className="font-mono text-sm"
              onChange={(event) =>
                dispatchState({ type: "set-env-file-path", envFilePath: event.target.value })
              }
            />
            <p className="text-[10px] text-muted-foreground/60">
              Copied from the project root into each new worktree before setup runs.
            </p>
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor={environmentInputId}
              className="text-xs font-medium text-muted-foreground"
            >
              Environment
            </label>
            <Textarea
              id={environmentInputId}
              value={envText}
              placeholder={"NODE_ENV=development\nAPI_BASE_URL=http://localhost:3000"}
              size="sm"
              className="font-mono text-sm"
              onChange={(event) =>
                dispatchState({ type: "set-env-text", envText: event.target.value })
              }
            />
            <p className="text-[10px] text-muted-foreground/60">
              Passed to the setup command and used if the source env file is missing.
            </p>
          </div>
        </div>
      </div>
      {validationError ? (
        <div className="mt-2 text-xs text-destructive">{validationError}</div>
      ) : null}
    </div>
  );
}

function projectWorktreeSetupEditorKey(project: Project): string {
  const setupScript = setupProjectScript(project.scripts);
  if (!setupScript) {
    return `${project.id}:empty`;
  }
  return JSON.stringify({
    projectId: project.id,
    command: setupScript.command,
    env: setupScript.env ?? {},
    envFilePath: setupScript.envFilePath ?? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH,
  });
}

interface ProjectEnvironmentWorktreesState {
  readonly worktreeSearch: string;
  readonly worktreeFilter: EnvironmentWorktreeFilter;
  readonly worktreeSort: EnvironmentWorktreeSort;
  readonly cleanupAge: EnvironmentWorktreeCleanupAge;
  readonly cleanupReferenceTimeMs: number;
  readonly isCleaningWorktrees: boolean;
  readonly isDeletingSelectedWorktrees: boolean;
  readonly selectedWorktreePaths: ReadonlySet<string>;
}

type ProjectEnvironmentWorktreesAction =
  | { readonly type: "set-worktree-search"; readonly worktreeSearch: string }
  | { readonly type: "set-worktree-filter"; readonly worktreeFilter: EnvironmentWorktreeFilter }
  | { readonly type: "set-worktree-sort"; readonly worktreeSort: EnvironmentWorktreeSort }
  | { readonly type: "set-cleanup-age"; readonly cleanupAge: EnvironmentWorktreeCleanupAge }
  | { readonly type: "set-cleaning-worktrees"; readonly isCleaningWorktrees: boolean }
  | {
      readonly type: "set-deleting-selected-worktrees";
      readonly isDeletingSelectedWorktrees: boolean;
    }
  | {
      readonly type: "set-selected-worktree-paths";
      readonly selectedWorktreePaths: ReadonlySet<string>;
    }
  | {
      readonly type: "update-selected-worktree-paths";
      readonly update: (current: ReadonlySet<string>) => ReadonlySet<string>;
    };

function projectEnvironmentWorktreesStateReducer(
  state: ProjectEnvironmentWorktreesState,
  action: ProjectEnvironmentWorktreesAction,
): ProjectEnvironmentWorktreesState {
  switch (action.type) {
    case "set-worktree-search":
      return state.worktreeSearch === action.worktreeSearch
        ? state
        : { ...state, worktreeSearch: action.worktreeSearch };
    case "set-worktree-filter":
      return state.worktreeFilter === action.worktreeFilter
        ? state
        : { ...state, worktreeFilter: action.worktreeFilter };
    case "set-worktree-sort":
      return state.worktreeSort === action.worktreeSort
        ? state
        : { ...state, worktreeSort: action.worktreeSort };
    case "set-cleanup-age":
      return state.cleanupAge === action.cleanupAge
        ? state
        : { ...state, cleanupAge: action.cleanupAge };
    case "set-cleaning-worktrees":
      return state.isCleaningWorktrees === action.isCleaningWorktrees
        ? state
        : { ...state, isCleaningWorktrees: action.isCleaningWorktrees };
    case "set-deleting-selected-worktrees":
      return state.isDeletingSelectedWorktrees === action.isDeletingSelectedWorktrees
        ? state
        : { ...state, isDeletingSelectedWorktrees: action.isDeletingSelectedWorktrees };
    case "set-selected-worktree-paths":
      return state.selectedWorktreePaths === action.selectedWorktreePaths
        ? state
        : { ...state, selectedWorktreePaths: action.selectedWorktreePaths };
    case "update-selected-worktree-paths": {
      const selectedWorktreePaths = action.update(state.selectedWorktreePaths);
      return state.selectedWorktreePaths === selectedWorktreePaths
        ? state
        : { ...state, selectedWorktreePaths };
    }
  }
}

function ProjectEnvironmentWorktrees({
  project,
  threads,
}: {
  readonly project: Project;
  readonly threads: readonly Thread[];
}) {
  const projectConnectionUrl = resolveConnectionForProjectId(project.id) ?? null;
  const {
    data: branchesData,
    error: branchesError,
    isError: branchesIsError,
    isFetching: branchesIsFetching,
    isLoading: branchesIsLoading,
    refetch: refetchBranches,
  } = useQuery(gitBranchesQueryOptions(project.cwd, projectConnectionUrl));
  const navigate = useNavigate();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const worktreeSearchInputId = useId();
  const [worktreesState, dispatchWorktreesState] = useReducer(
    projectEnvironmentWorktreesStateReducer,
    undefined,
    (): ProjectEnvironmentWorktreesState => ({
      worktreeSearch: "",
      worktreeFilter: "inactive",
      worktreeSort: "oldest",
      cleanupAge: "30d",
      cleanupReferenceTimeMs: Date.now(),
      isCleaningWorktrees: false,
      isDeletingSelectedWorktrees: false,
      selectedWorktreePaths: new Set(),
    }),
  );
  const {
    cleanupAge,
    cleanupReferenceTimeMs,
    isCleaningWorktrees,
    isDeletingSelectedWorktrees,
    selectedWorktreePaths,
    worktreeFilter,
    worktreeSearch,
    worktreeSort,
  } = worktreesState;
  const { deleteWorktreeAndRelatedData } = useThreadActions();
  const projectSshKeyPassphrase =
    settings.gitSshKeyPassphraseByProjectRoot[project.cwd] ??
    DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase;
  const hasProjectSshKeyPassphrase = projectSshKeyPassphrase.trim().length > 0;
  const updateProjectSshKeyPassphrase = (passphrase: string) => {
    const nextPassphrases = { ...settings.gitSshKeyPassphraseByProjectRoot };
    if (passphrase.trim().length > 0) {
      nextPassphrases[project.cwd] = passphrase;
    } else {
      delete nextPassphrases[project.cwd];
    }
    updateSettings({ gitSshKeyPassphraseByProjectRoot: nextPassphrases });
  };
  const projectThreads = threads.filter((thread) => thread.projectId === project.id);
  const worktrees = getEnvironmentWorktreeEntries({
    branches: branchesData?.branches ?? [],
    project,
    threads: projectThreads,
  });
  const worktreePaths = worktrees.map((worktree) => worktree.path);
  const { data: statsData, isFetching: statsIsFetching } = useQuery(
    gitWorktreeStatsQueryOptions({ connectionUrl: projectConnectionUrl, paths: worktreePaths }),
  );
  const statsByPath = (() => {
    const stats = new Map<string, EnvironmentWorktreeStats>();
    for (const worktreeStats of statsData?.worktrees ?? []) {
      stats.set(worktreeStats.path, worktreeStats);
    }
    return stats;
  })();
  const visibleWorktrees = (() => {
    const query = worktreeSearch.trim().toLowerCase();
    return worktrees
      .filter((worktree) => {
        if (worktreeFilter === "active") {
          return worktree.activeThread !== null;
        }
        if (worktreeFilter === "inactive") {
          return worktree.activeThread === null;
        }
        if (worktreeFilter === "linked") {
          return worktree.relatedThreads.length > 0;
        }
        if (query.length === 0) {
          return true;
        }
        const haystack = [
          worktree.displayName,
          worktree.path,
          ...worktree.branchNames,
          ...worktree.path.split("/"),
        ]
          .join("\n")
          .toLowerCase();
        return haystack.includes(query);
      })
      .toSorted((left, right) => {
        if (worktreeSort === "storage") {
          const storageDiff =
            (statsByPath.get(right.path)?.sizeBytes ?? -1) -
            (statsByPath.get(left.path)?.sizeBytes ?? -1);
          if (storageDiff !== 0) return storageDiff;
        } else if (worktreeSort === "recent") {
          const activityDiff =
            getWorktreeActivityTimeMs(right, statsByPath.get(right.path)) -
            getWorktreeActivityTimeMs(left, statsByPath.get(left.path));
          if (activityDiff !== 0) return activityDiff;
        } else if (worktreeSort === "oldest") {
          const activityDiff =
            getWorktreeActivityTimeMs(left, statsByPath.get(left.path)) -
            getWorktreeActivityTimeMs(right, statsByPath.get(right.path));
          if (activityDiff !== 0) return activityDiff;
        }
        return (
          left.displayName.localeCompare(right.displayName) || left.path.localeCompare(right.path)
        );
      });
  })();
  const availableWorktreePaths = new Set(worktrees.map((worktree) => worktree.path));
  const effectiveSelectedWorktreePaths = new Set(
    Array.from(selectedWorktreePaths).filter((path) => availableWorktreePaths.has(path)),
  );
  const visibleSelectableWorktrees = visibleWorktrees.filter(
    (worktree) => worktree.activeThread === null,
  );
  const selectedWorktrees = worktrees.filter(
    (worktree) =>
      worktree.activeThread === null && effectiveSelectedWorktreePaths.has(worktree.path),
  );
  const selectedStorageBytes = selectedWorktrees.reduce(
    (total, worktree) => total + (statsByPath.get(worktree.path)?.sizeBytes ?? 0),
    0,
  );
  const selectedLinkedChatCount = selectedWorktrees.reduce(
    (total, worktree) => total + worktree.relatedThreads.length,
    0,
  );
  const allVisibleSelectableSelected =
    visibleSelectableWorktrees.length > 0 &&
    visibleSelectableWorktrees.every((worktree) =>
      effectiveSelectedWorktreePaths.has(worktree.path),
    );
  const toggleWorktreeSelected = (path: string, selected: boolean) => {
    dispatchWorktreesState({
      type: "update-selected-worktree-paths",
      update: (current) => {
        const next = new Set(current);
        if (selected) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return next;
      },
    });
  };
  const setVisibleWorktreesSelected = (selected: boolean) => {
    dispatchWorktreesState({
      type: "update-selected-worktree-paths",
      update: (current) => {
        const next = new Set(current);
        for (const worktree of visibleSelectableWorktrees) {
          if (selected) {
            next.add(worktree.path);
          } else {
            next.delete(worktree.path);
          }
        }
        return next;
      },
    });
  };
  const clearSelectedWorktrees = () => {
    dispatchWorktreesState({
      type: "set-selected-worktree-paths",
      selectedWorktreePaths: new Set(),
    });
  };
  const cleanupCandidates = worktrees
    .filter(
      (worktree) =>
        worktree.activeThread === null &&
        isWorktreeOlderThan(
          worktree,
          statsByPath.get(worktree.path),
          cleanupAge,
          cleanupReferenceTimeMs,
        ),
    )
    .toSorted(
      (left, right) =>
        getWorktreeActivityTimeMs(left, statsByPath.get(left.path)) -
          getWorktreeActivityTimeMs(right, statsByPath.get(right.path)) ||
        left.displayName.localeCompare(right.displayName) ||
        left.path.localeCompare(right.path),
    );
  const cleanupStorageBytes = cleanupCandidates.reduce(
    (total, worktree) => total + (statsByPath.get(worktree.path)?.sizeBytes ?? 0),
    0,
  );
  const cleanupLinkedChatCount = cleanupCandidates.reduce(
    (total, worktree) => total + worktree.relatedThreads.length,
    0,
  );
  const handleCleanupCandidates = async () => {
    const api = readNativeApi();
    if (!api || cleanupCandidates.length === 0 || isCleaningWorktrees) {
      return;
    }
    const confirmed = await api.dialogs.confirm(
      [
        `Delete ${formatCountLabel(cleanupCandidates.length, "inactive worktree")}?`,
        `This can free about ${formatStorageBytes(cleanupStorageBytes)} and will also delete ${formatCountLabel(
          cleanupLinkedChatCount,
          "linked chat",
        )}.`,
        "",
        "Active agent worktrees are not included.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }

    dispatchWorktreesState({ type: "set-cleaning-worktrees", isCleaningWorktrees: true });
    try {
      await Promise.all(
        cleanupCandidates.map((worktree) =>
          deleteWorktreeAndRelatedData({
            connectionUrl: projectConnectionUrl,
            projectId: project.id,
            projectCwd: project.cwd,
            skipConfirmation: true,
            suppressSuccessToast: true,
            worktreePath: worktree.path,
          }),
        ),
      );
      toastManager.add({
        type: "success",
        title: "Worktrees cleaned up",
        description: `Removed ${formatCountLabel(cleanupCandidates.length, "worktree")} and freed up to ${formatStorageBytes(
          cleanupStorageBytes,
        )}.`,
      });
      void refetchBranches();
    } catch (error) {
      dispatchWorktreesState({ type: "set-cleaning-worktrees", isCleaningWorktrees: false });
      throw error;
    }
    dispatchWorktreesState({ type: "set-cleaning-worktrees", isCleaningWorktrees: false });
  };
  const handleDeleteSelectedWorktrees = async () => {
    const api = readNativeApi();
    if (!api || selectedWorktrees.length === 0 || isDeletingSelectedWorktrees) {
      return;
    }
    const confirmed = await api.dialogs.confirm(
      [
        `Delete ${formatCountLabel(selectedWorktrees.length, "selected worktree")}?`,
        `This can free about ${formatStorageBytes(selectedStorageBytes)} and will also delete ${formatCountLabel(
          selectedLinkedChatCount,
          "linked chat",
        )}.`,
        "",
        "Active agent worktrees are not included.",
      ].join("\n"),
    );
    if (!confirmed) {
      return;
    }

    dispatchWorktreesState({
      type: "set-deleting-selected-worktrees",
      isDeletingSelectedWorktrees: true,
    });
    try {
      await Promise.all(
        selectedWorktrees.map((worktree) =>
          deleteWorktreeAndRelatedData({
            connectionUrl: projectConnectionUrl,
            projectId: project.id,
            projectCwd: project.cwd,
            skipConfirmation: true,
            suppressSuccessToast: true,
            worktreePath: worktree.path,
          }),
        ),
      );
      dispatchWorktreesState({
        type: "set-selected-worktree-paths",
        selectedWorktreePaths: new Set(),
      });
      toastManager.add({
        type: "success",
        title: "Selected worktrees deleted",
        description: `Removed ${formatCountLabel(selectedWorktrees.length, "worktree")} and freed up to ${formatStorageBytes(
          selectedStorageBytes,
        )}.`,
      });
      void refetchBranches();
    } catch (error) {
      dispatchWorktreesState({
        type: "set-deleting-selected-worktrees",
        isDeletingSelectedWorktrees: false,
      });
      throw error;
    }
    dispatchWorktreesState({
      type: "set-deleting-selected-worktrees",
      isDeletingSelectedWorktrees: false,
    });
  };

  return (
    <div id={`project-environment-${project.id}`} className="flex min-w-0 flex-col gap-5 sm:gap-6">
      <SettingsPageHeader
        pageLabel={
          <span className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-6 shrink-0 text-muted-foreground/65 hover:text-foreground"
              onClick={() => void navigate({ to: "/settings/environment" })}
              aria-label="Back to projects"
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <span className="min-w-0 truncate">{project.name}</span>
          </span>
        }
      />

      <SettingsSection
        title="Worktree setup"
        description="Runs after a new worktree is created. Use it for install, bootstrap, or generated files."
      >
        <ProjectWorktreeSetupEditor
          key={projectWorktreeSetupEditorKey(project)}
          project={project}
        />
      </SettingsSection>

      <SettingsSection title="Credentials">
        <SettingsRow
          title="SSH key passphrase"
          description="Overrides the global Git SSH key passphrase for this project and its worktrees."
          resetAction={
            hasProjectSshKeyPassphrase ? (
              <SettingResetButton
                label="project Git SSH key passphrase"
                onClick={() =>
                  updateProjectSshKeyPassphrase(DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase)
                }
              />
            ) : null
          }
          status={hasProjectSshKeyPassphrase ? "Configured" : "Using global"}
          control={
            <SettingsInput
              type="password"
              className="w-full"
              value={projectSshKeyPassphrase}
              onChange={(event) => updateProjectSshKeyPassphrase(event.target.value)}
              placeholder={
                settings.gitSshKeyPassphrase.trim().length > 0
                  ? "Using global passphrase"
                  : "Optional private key passphrase"
              }
              aria-label="Project Git SSH key passphrase"
              autoComplete="off"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Manage worktrees"
        description="Delete unused local worktrees and their linked chats. Active agent worktrees stay locked."
        headerAction={
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            disabled={branchesIsFetching}
            onClick={() => void refetchBranches()}
            aria-label="Refresh worktrees"
          >
            <RefreshCwIcon className={cn("size-3.5", branchesIsFetching && "animate-spin")} />
          </Button>
        }
      >
        <div className={SETTINGS_ROW_INSET_CLASS_NAME}>
          <div className="flex min-w-0 flex-col gap-3">
            <label htmlFor={worktreeSearchInputId} className="min-w-0 space-y-1">
              <span className="block text-[10px] font-medium text-muted-foreground/58">Search</span>
              <span className="relative block">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                <SettingsInput
                  id={worktreeSearchInputId}
                  value={worktreeSearch}
                  placeholder="Name, path, branch"
                  className="h-8 pl-8"
                  onChange={(event) =>
                    dispatchWorktreesState({
                      type: "set-worktree-search",
                      worktreeSearch: event.target.value,
                    })
                  }
                />
              </span>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="block text-[10px] font-medium text-muted-foreground/58">Filter</span>
              <Select
                value={worktreeFilter}
                onValueChange={(value) =>
                  dispatchWorktreesState({
                    type: "set-worktree-filter",
                    worktreeFilter: value as EnvironmentWorktreeFilter,
                  })
                }
              >
                <SelectTrigger size="sm" className={SETTINGS_SELECT_TRIGGER_CLASS}>
                  <SelectValue>{ENVIRONMENT_WORKTREE_FILTER_LABELS[worktreeFilter]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(["inactive", "all", "linked", "active"] as const).map((filter) => (
                    <SelectItem key={filter} value={filter}>
                      {ENVIRONMENT_WORKTREE_FILTER_LABELS[filter]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="block text-[10px] font-medium text-muted-foreground/58">Sort</span>
              <Select
                value={worktreeSort}
                onValueChange={(value) =>
                  dispatchWorktreesState({
                    type: "set-worktree-sort",
                    worktreeSort: value as EnvironmentWorktreeSort,
                  })
                }
              >
                <SelectTrigger size="sm" className={SETTINGS_SELECT_TRIGGER_CLASS}>
                  <SelectValue>{ENVIRONMENT_WORKTREE_SORT_LABELS[worktreeSort]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(["oldest", "recent", "storage", "name"] as const).map((sort) => (
                    <SelectItem key={sort} value={sort}>
                      {ENVIRONMENT_WORKTREE_SORT_LABELS[sort]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
          </div>
        </div>

        {branchesIsError ? (
          <div className="mt-3 text-xs text-destructive">
            {branchesError instanceof Error
              ? branchesError.message
              : "Unable to load worktrees for this project."}
          </div>
        ) : null}

        {branchesIsLoading ? (
          <div className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground/60">
            <Spinner className="size-3" />
            Loading worktree inventory
          </div>
        ) : worktrees.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground/60">
            No additional worktrees detected.
          </div>
        ) : visibleWorktrees.length === 0 ? (
          <div className="mt-3 text-xs text-muted-foreground/60">
            No worktrees match the current search and filter.
          </div>
        ) : (
          <>
            <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 border-y border-border/20 py-2">
              <label className="inline-flex min-w-0 items-center gap-2 text-xs text-muted-foreground/70">
                <Checkbox
                  checked={allVisibleSelectableSelected}
                  disabled={visibleSelectableWorktrees.length === 0}
                  className="data-checked:border-border/55 data-checked:bg-foreground/65"
                  onCheckedChange={(checked) => setVisibleWorktreesSelected(Boolean(checked))}
                />
                <span>
                  Select visible
                  {visibleSelectableWorktrees.length > 0
                    ? ` (${visibleSelectableWorktrees.length})`
                    : ""}
                </span>
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground/62">
                <span>{formatCountLabel(selectedWorktrees.length, "selected")}</span>
                {selectedWorktrees.length > 0 ? (
                  <>
                    <span>{formatStorageBytes(selectedStorageBytes)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={clearSelectedWorktrees}
                    >
                      Clear
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive/86 hover:bg-destructive/10 hover:text-destructive"
                      disabled={isDeletingSelectedWorktrees}
                      onClick={() => void handleDeleteSelectedWorktrees()}
                    >
                      {isDeletingSelectedWorktrees ? (
                        <Spinner className="size-3" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                      Delete selected
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="divide-y divide-border/18">
              {visibleWorktrees.map((worktree) => {
                const relatedChatCount = worktree.relatedThreads.length;
                const isActive = worktree.activeThread !== null;
                const isSelected = effectiveSelectedWorktreePaths.has(worktree.path);
                const stats = statsByPath.get(worktree.path);
                const isStorageRefreshing = statsIsFetching && worktreePaths.length > 0;
                return (
                  <div
                    key={worktree.path}
                    className={cn(
                      SETTINGS_LIST_ROW_CLASS_NAME,
                      isSelected && "bg-foreground/[0.03]",
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Checkbox
                        checked={isSelected}
                        disabled={isActive}
                        aria-label={`Select ${worktree.displayName}`}
                        className="mt-0.5 data-checked:border-border/55 data-checked:bg-foreground/65"
                        onCheckedChange={(checked) =>
                          toggleWorktreeSelected(worktree.path, Boolean(checked))
                        }
                      />
                      <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/55" />
                      <div className="min-w-0 space-y-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground/90">
                            {worktree.displayName}
                          </span>
                          {isActive ? (
                            <Badge variant="outline" size="sm" className="text-[10px]">
                              In use
                            </Badge>
                          ) : null}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground/50">
                          {worktree.path}
                        </div>
                        <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground/60">
                          <span>{formatCountLabel(worktree.branchNames.length, "branch")}</span>
                          <span>{formatCountLabel(relatedChatCount, "linked chat")}</span>
                          <span className="inline-flex items-center gap-1">
                            <ClockIcon className="size-3" />
                            {formatWorktreeActivityLabel(worktree, stats)}
                          </span>
                          {worktree.branchNames.length > 0 ? (
                            <span className="min-w-0 truncate">
                              {worktree.branchNames.slice(0, 3).join(", ")}
                              {worktree.branchNames.length > 3 ? "..." : ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <HardDriveIcon className="size-3" />
                        {stats ? formatStorageBytes(stats.sizeBytes) : "Storage"}
                        {isStorageRefreshing ? <Spinner className="size-3" /> : null}
                      </span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              className="text-destructive/82 hover:bg-destructive/10 hover:text-destructive"
                              disabled={isActive}
                              onClick={() =>
                                void deleteWorktreeAndRelatedData({
                                  connectionUrl: projectConnectionUrl,
                                  projectId: project.id,
                                  projectCwd: project.cwd,
                                  worktreePath: worktree.path,
                                })
                              }
                              aria-label={`Delete ${worktree.displayName}`}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          }
                        />
                        {isActive ? (
                          <TooltipPopup side="top">
                            Stop the active agent in "{worktree.activeThread?.title}" first.
                          </TooltipPopup>
                        ) : (
                          <TooltipPopup side="top">
                            Delete this worktree and its linked chats.
                          </TooltipPopup>
                        )}
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {worktrees.length > 0 ? (
          <div className="mt-5 border-t border-border/40 px-4 pt-4 sm:px-5">
            <div className="flex flex-col gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground/92">
                  <Trash2Icon className="size-3.5 text-muted-foreground" />
                  Cleanup
                </div>
                <p className="mt-1 text-xs text-muted-foreground/60">
                  Remove inactive worktrees by age. Active agent worktrees are excluded.
                </p>
                <div className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground/62">
                  <span>{formatCountLabel(cleanupCandidates.length, "candidate")}</span>
                  <span>{formatStorageBytes(cleanupStorageBytes)}</span>
                  <span>{formatCountLabel(cleanupLinkedChatCount, "linked chat")}</span>
                  {statsIsFetching ? (
                    <span className="inline-flex items-center gap-1">
                      <Spinner className="size-3" />
                      Updating storage
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap items-end gap-2">
                <label className="min-w-44 space-y-1">
                  <span className="block text-[10px] font-medium text-muted-foreground/58">
                    Cleanup range
                  </span>
                  <Select
                    value={cleanupAge}
                    onValueChange={(value) =>
                      dispatchWorktreesState({
                        type: "set-cleanup-age",
                        cleanupAge: value as EnvironmentWorktreeCleanupAge,
                      })
                    }
                  >
                    <SelectTrigger size="sm" className={SETTINGS_SELECT_TRIGGER_CLASS}>
                      <SelectValue>
                        {ENVIRONMENT_WORKTREE_CLEANUP_AGE_LABELS[cleanupAge]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {(["30d", "90d", "7d", "all"] as const).map((age) => (
                        <SelectItem key={age} value={age}>
                          {ENVIRONMENT_WORKTREE_CLEANUP_AGE_LABELS[age]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive/86 hover:bg-destructive/10 hover:text-destructive"
                  disabled={cleanupCandidates.length === 0 || isCleaningWorktrees}
                  onClick={() => void handleCleanupCandidates()}
                >
                  {isCleaningWorktrees ? (
                    <Spinner className="size-3" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                  Delete candidates
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}

export function EnvironmentSettingsPanel() {
  const projects = useStore((store) => store.projects);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<EnvironmentProjectFilter>("all");
  const [projectSort, setProjectSort] = useState<EnvironmentProjectSort>("inactive");
  const [projectMetricsById, setProjectMetricsById] = useState<
    Partial<Record<ProjectId, EnvironmentProjectMetrics>>
  >({});
  const activeLocalProjects = projects
    .filter((project) => project.archivedAt === null)
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  const updateProjectMetrics = (projectId: ProjectId, metrics: EnvironmentProjectMetrics) => {
    setProjectMetricsById((current) => {
      const previous = current[projectId];
      if (
        previous &&
        previous.hasSetup === metrics.hasSetup &&
        previous.storageBytes === metrics.storageBytes &&
        previous.worktreeCount === metrics.worktreeCount
      ) {
        return current;
      }
      return { ...current, [projectId]: metrics };
    });
  };
  const filteredProjects = (() => {
    const query = projectSearch.trim().toLowerCase();
    const searchedProjects =
      query.length === 0
        ? activeLocalProjects
        : activeLocalProjects.filter((project) => {
            const haystack = `${project.name}\n${project.cwd}`.toLowerCase();
            return haystack.includes(query);
          });
    const filteredByStatus = searchedProjects.filter((project) => {
      const metrics = projectMetricsById[project.id];
      if (projectFilter === "with-worktrees") {
        return metrics ? metrics.worktreeCount > 0 : true;
      }
      if (projectFilter === "inactive") {
        return metrics ? metrics.worktreeCount === 0 : true;
      }
      if (projectFilter === "setup") {
        return metrics?.hasSetup ?? setupProjectScript(project.scripts) !== null;
      }
      return true;
    });

    return filteredByStatus.toSorted((left, right) => {
      const leftMetrics = projectMetricsById[left.id];
      const rightMetrics = projectMetricsById[right.id];
      if (projectSort === "inactive") {
        const leftInactive = leftMetrics ? leftMetrics.worktreeCount === 0 : false;
        const rightInactive = rightMetrics ? rightMetrics.worktreeCount === 0 : false;
        if (leftInactive !== rightInactive) {
          return leftInactive ? -1 : 1;
        }
      } else if (projectSort === "worktrees") {
        const byWorktrees =
          (rightMetrics?.worktreeCount ?? -1) - (leftMetrics?.worktreeCount ?? -1);
        if (byWorktrees !== 0) {
          return byWorktrees;
        }
      } else if (projectSort === "storage") {
        const byStorage = (rightMetrics?.storageBytes ?? -1) - (leftMetrics?.storageBytes ?? -1);
        if (byStorage !== 0) {
          return byStorage;
        }
      }
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
  })();
  const hasActiveFilter = projectFilter !== "all" || projectSort !== "name" || projectSearch.trim();
  const duplicateProjectNames = buildDuplicateProjectNameSet(activeLocalProjects);

  const clearProjectControls = () => {
    setProjectSearch("");
    setProjectFilter("all");
    setProjectSort("name");
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Environment"
        description="Choose a project to configure worktree setup commands, environment variables, and cleanup."
      >
        {activeLocalProjects.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia>
                <GitForkIcon className="size-5" />
              </EmptyMedia>
              <EmptyTitle>No local projects</EmptyTitle>
              <EmptyDescription>
                Add a local project to configure worktree setup and cleanup.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="min-w-0 space-y-4 py-3.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                <SettingsInput
                  value={projectSearch}
                  placeholder="Search projects"
                  className="h-8 pl-8"
                  aria-label="Search projects"
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                <Select
                  value={projectFilter}
                  onValueChange={(value) => setProjectFilter(value as EnvironmentProjectFilter)}
                >
                  <SelectTrigger
                    aria-label="Filter projects"
                    className={cn(SETTINGS_FIELD_CLASS, "w-[8.75rem]")}
                    size="default"
                  >
                    <SelectValue>{ENVIRONMENT_PROJECT_FILTER_LABELS[projectFilter]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(
                      [
                        "all",
                        "inactive",
                        "with-worktrees",
                        "setup",
                      ] as const satisfies readonly EnvironmentProjectFilter[]
                    ).map((value) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {ENVIRONMENT_PROJECT_FILTER_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select
                  value={projectSort}
                  onValueChange={(value) => setProjectSort(value as EnvironmentProjectSort)}
                >
                  <SelectTrigger
                    aria-label="Sort projects"
                    className={cn(SETTINGS_FIELD_CLASS, "w-[8.75rem]")}
                    size="default"
                  >
                    <SelectValue>{ENVIRONMENT_PROJECT_SORT_LABELS[projectSort]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(
                      [
                        "inactive",
                        "name",
                        "worktrees",
                        "storage",
                      ] as const satisfies readonly EnvironmentProjectSort[]
                    ).map((value) => (
                      <SelectItem hideIndicator key={value} value={value}>
                        {ENVIRONMENT_PROJECT_SORT_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {hasActiveFilter ? (
                  <Button type="button" size="sm" variant="ghost" onClick={clearProjectControls}>
                    Reset
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>
                {filteredProjects.length} project{filteredProjects.length === 1 ? "" : "s"}
              </span>
              {duplicateProjectNames.size > 0 ? (
                <span className="text-right">Duplicate names include a worktree id</span>
              ) : null}
            </div>

            {filteredProjects.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia>
                    <SearchIcon className="size-5" />
                  </EmptyMedia>
                  <EmptyTitle>No matching projects</EmptyTitle>
                  <EmptyDescription>Try a different project name or path.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredProjects.map((project) => (
                  <EnvironmentProjectRow
                    key={project.id}
                    duplicateNames={duplicateProjectNames}
                    project={project}
                    onMetricsChange={updateProjectMetrics}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentProjectRow({
  duplicateNames,
  onMetricsChange,
  project,
}: {
  readonly duplicateNames: ReadonlySet<string>;
  readonly onMetricsChange: (projectId: ProjectId, metrics: EnvironmentProjectMetrics) => void;
  readonly project: Project;
}) {
  const navigate = useNavigate();
  const projectConnectionUrl = resolveConnectionForProjectId(project.id) ?? null;
  const {
    data: branchesData,
    isError: branchesIsError,
    isLoading: branchesIsLoading,
  } = useQuery(gitBranchesQueryOptions(project.cwd, projectConnectionUrl));
  const worktreePaths = getProjectWorktreePaths({
    branches: branchesData?.branches ?? [],
    project,
  });
  const { data: statsData, isFetching: statsIsFetching } = useQuery(
    gitWorktreeStatsQueryOptions({ connectionUrl: projectConnectionUrl, paths: worktreePaths }),
  );
  const setupScript = setupProjectScript(project.scripts);
  const environmentCount = Object.keys(setupScript?.env ?? {}).length;
  const totalStorageBytes =
    statsData?.worktrees.reduce((total, worktree) => total + worktree.sizeBytes, 0) ?? 0;
  const onMetricsChangeEffect = useEffectEvent(onMetricsChange);
  useEffect(() => {
    onMetricsChangeEffect(project.id, {
      hasSetup: setupScript !== null,
      storageBytes: totalStorageBytes,
      worktreeCount: worktreePaths.length,
    });
  }, [project.id, setupScript, totalStorageBytes, worktreePaths.length]);
  const worktreeCountLabel = branchesIsError
    ? "Unavailable"
    : formatCountLabel(worktreePaths.length, "worktree");
  const isLoadingWorktrees = branchesIsLoading;
  const storageLabel =
    worktreePaths.length === 0 ? "0 B" : !statsData ? "…" : formatStorageBytes(totalStorageBytes);
  const isRefreshingStorage = worktreePaths.length > 0 && statsIsFetching;
  const pathLine = formatEnvironmentProjectPathLine(project);
  const displayName = formatEnvironmentProjectDisplayName(project, duplicateNames);

  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        SETTINGS_LIST_ROW_BUTTON_CLASS,
        "!h-auto w-full justify-start rounded-lg px-3.5 !py-3.5 font-normal whitespace-normal hover:bg-foreground/[0.03] active:bg-foreground/[0.05]",
      )}
      onClick={() =>
        void navigate({
          to: "/settings/project-environment/$projectId",
          params: { projectId: project.id },
        })
      }
    >
      <div className="grid w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5 sm:grid-cols-[1.25rem_minmax(0,1fr)_7.5rem_5.5rem_1.25rem] sm:items-start">
        <ProjectAvatar project={project} className="mt-1 size-4 shrink-0" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{displayName}</span>
            {setupScript ? (
              <span className="shrink-0 rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                setup
              </span>
            ) : null}
            {environmentCount > 0 ? (
              <span className="shrink-0 rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {environmentCount} env
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/60">{pathLine}</p>
        </div>
        <span className="hidden items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:inline-flex mt-0.5">
          {worktreeCountLabel}
          {isLoadingWorktrees ? <Spinner className="size-2.5" /> : null}
        </span>
        <span className="hidden items-center justify-end gap-1 text-xs tabular-nums text-muted-foreground sm:inline-flex mt-0.5">
          {storageLabel}
          {isRefreshingStorage ? <Spinner className="size-2.5" /> : null}
        </span>
        <ArrowRightIcon className="hidden size-4 shrink-0 text-muted-foreground/55 transition-colors group-hover/button:text-foreground/75 sm:block mt-0.5" />
        <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:hidden">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {worktreeCountLabel}
            {isLoadingWorktrees ? <Spinner className="size-2.5" /> : null}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {storageLabel}
            {isRefreshingStorage ? <Spinner className="size-2.5" /> : null}
          </span>
        </div>
      </div>
    </Button>
  );
}

export function ProjectEnvironmentSettingsPanel({ projectId }: { readonly projectId: ProjectId }) {
  const navigate = useNavigate();
  const project = useStore((store) =>
    store.projects.find((candidate) => candidate.id === projectId),
  );
  const threads = useStore((store) => store.threads);

  if (!project || project.archivedAt !== null) {
    return (
      <SettingsPageContainer>
        <SettingsSection
          title="Project environment"
          description="This project is no longer available."
          headerAction={
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/environment" })}
            >
              <ArrowLeftIcon className="size-3.5" />
              Projects
            </Button>
          }
        >
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia>
                <GitForkIcon className="size-5" />
              </EmptyMedia>
              <EmptyTitle>Project not found</EmptyTitle>
              <EmptyDescription>
                Choose another project to configure worktree setup and cleanup.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <div className="min-w-0">
        <ProjectEnvironmentWorktrees project={project} threads={threads} />
      </div>
    </SettingsPageContainer>
  );
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
  const threadCountByProjectId = (() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    }
    return counts;
  })();
  const archivedGroups = (() => {
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    const nextGroups: ArchivedProjectGroup[] = [];
    for (const project of projectById.values()) {
      const archivedThreads = threads
        .filter((thread) => thread.projectId === project.id && thread.archivedAt !== null)
        .toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.updatedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.updatedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        });
      if (project.archivedAt === null && archivedThreads.length === 0) {
        continue;
      }
      nextGroups.push({
        project,
        threads: archivedThreads,
        totalThreadCount: threadCountByProjectId.get(project.id) ?? 0,
        sortKey: getArchiveSortKey(project, archivedThreads),
      });
    }
    return nextGroups.toSorted(
      (left, right) =>
        right.sortKey.localeCompare(left.sortKey) ||
        left.project.name.localeCompare(right.project.name) ||
        right.project.id.localeCompare(left.project.id),
    );
  })();
  const [openGroupIds, setOpenGroupIds] = useState<Record<string, boolean>>({});
  const visibleOpenGroupIds = Object.fromEntries(
    archivedGroups.map((group) => [group.project.id, openGroupIds[group.project.id] ?? true]),
  );

  const handleArchivedThreadContextMenu = async (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => {
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
  };
  const hasArchivedItems = archivedGroups.length > 0;
  const allGroupsExpanded = archivedGroups.every(
    (group) => visibleOpenGroupIds[group.project.id] !== false,
  );
  const setAllGroupsOpen = (open: boolean) => {
    const next: Record<string, boolean> = {};
    for (const group of archivedGroups) {
      next[group.project.id] = open;
    }
    setOpenGroupIds(next);
  };
  const setGroupOpen = (projectId: Project["id"], open: boolean) => {
    setOpenGroupIds((current) => ({ ...current, [projectId]: open }));
  };

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
          title="Archived items"
          headerAction={
            archivedGroups.length > 1 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        allGroupsExpanded ? "Collapse all projects" : "Expand all projects"
                      }
                      onClick={() => setAllGroupsOpen(!allGroupsExpanded)}
                    />
                  }
                >
                  {allGroupsExpanded ? (
                    <IconArrowsDiagonalMinimize2 className="size-4" />
                  ) : (
                    <IconArrowsDiagonal className="size-4" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="right">
                  {allGroupsExpanded ? "Collapse all" : "Expand all"}
                </TooltipPopup>
              </Tooltip>
            ) : null
          }
        >
          <div className="min-w-0 space-y-0 px-2 py-2 sm:px-3">
            {archivedGroups.map((group) => {
              const project = group.project;
              const isOpen = visibleOpenGroupIds[project.id] !== false;
              const archivedItemCount =
                group.threads.length + (project.archivedAt === null ? 0 : 1);

              return (
                <div key={project.id} className="min-w-0 py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      SETTINGS_LIST_ROW_BUTTON_CLASS,
                      "!h-9 w-full justify-start gap-2.5 px-2.5 hover:bg-muted/20",
                    )}
                    aria-expanded={isOpen}
                    onClick={() => setGroupOpen(project.id, !isOpen)}
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-200",
                        !isOpen && "-rotate-90",
                      )}
                      aria-hidden="true"
                    />
                    <ProjectAvatar
                      project={project}
                      className="size-3.5 rounded-[4px] opacity-70"
                    />
                    <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/84">
                      {project.name}
                    </h3>
                    {project.archivedAt !== null ? (
                      <span className="shrink-0 text-[10px] font-medium text-muted-foreground/48">
                        project
                      </span>
                    ) : null}
                    <span className="shrink-0 text-[10px] text-muted-foreground/45 tabular-nums">
                      {formatCountLabel(archivedItemCount, "item")} ·{" "}
                      {formatCountLabel(group.threads.length, "thread")}
                    </span>
                  </Button>

                  <Collapsible
                    open={isOpen}
                    onOpenChange={(open) => setGroupOpen(project.id, open)}
                  >
                    <CollapsibleContent>
                      <div className="mt-0.5 space-y-0.5 pl-6">
                        {project.archivedAt !== null ? (
                          <div className="flex min-h-8 flex-col gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-medium text-foreground/82">
                                Project archive
                              </h4>
                              <p className="truncate text-[10px] text-muted-foreground/50">
                                {formatRelativeTimeLabel(
                                  project.archivedAt ??
                                    project.updatedAt ??
                                    project.createdAt ??
                                    "",
                                )}{" "}
                                · {formatCountLabel(group.totalThreadCount, "thread")} total
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 shrink-0 cursor-pointer gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground/64 hover:bg-muted/25 hover:text-foreground"
                              onClick={() =>
                                void restoreArchivedProject(project.id).catch((error) => {
                                  toastManager.add({
                                    type: "error",
                                    title: "Failed to restore project",
                                    description:
                                      error instanceof Error ? error.message : "An error occurred.",
                                  });
                                })
                              }
                            >
                              <ArchiveX className="size-3" />
                              <span>Unarchive</span>
                            </Button>
                          </div>
                        ) : null}

                        {group.threads.map((thread) => (
                          <div
                            key={thread.id}
                            className="flex min-h-8 flex-col gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/20 sm:flex-row sm:items-center sm:justify-between"
                            onContextMenu={(event) => {
                              event.preventDefault();
                              void handleArchivedThreadContextMenu(thread.id, {
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                          >
                            <div className="min-w-0">
                              <h4 className="truncate text-sm font-medium text-foreground/84">
                                {thread.title}
                              </h4>
                              <p className="truncate text-[10px] text-muted-foreground/50">
                                {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)} ·
                                created {formatRelativeTimeLabel(thread.createdAt)}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 shrink-0 cursor-pointer gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground/64 hover:bg-muted/25 hover:text-foreground"
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
                              <ArchiveX className="size-3" />
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
          </div>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
