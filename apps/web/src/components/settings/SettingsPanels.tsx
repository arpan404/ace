import {
  ArchiveIcon,
  ArchiveX,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderGit2Icon,
  GitForkIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { IconArrowsDiagonal, IconArrowsDiagonalMinimize2 } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProjectAvatar } from "../ProjectAvatar";
import type { Project, Thread } from "../../types";
import { ProviderSettingsSection, type ProviderCard } from "./ProviderSettingsSection";
import { PROVIDER_SETTINGS } from "./settingsProviderConfig";
import { KeybindingsSettingsEditor } from "./KeybindingsSettingsEditor";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingResetButton,
  getProviderSummary,
  getProviderVersionLabel,
} from "./SettingsPanelPrimitives";
import { applyProvidersUpdated, useServerProviders } from "../../rpc/serverState";

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

type SettingsPanelPage =
  | "general"
  | "browser"
  | "chat"
  | "editor"
  | "providers"
  | "advanced"
  | "about";

function useSettingsPanelComponent({ page }: { page: SettingsPanelPage }) {
  const { theme, setTheme } = useTheme();
  const { themePreset, setThemePreset } = useAppearancePrefs();
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
  const refreshProviders = useCallback(() => {
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
  }, []);
  const upgradeProviderCli = useCallback(
    (provider: ProviderKind, runtimeId: string) => {
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
    },
    [upgradingRuntimeKey],
  );
  const isUpgradingProvider = useCallback(
    (provider: ProviderKind) =>
      upgradingRuntimeKey !== null && upgradingRuntimeKey.startsWith(`${provider}:`),
    [upgradingRuntimeKey],
  );
  const isUpgradingRuntime = useCallback(
    (provider: ProviderKind, runtimeId: string) =>
      upgradingRuntimeKey === `${provider}:${runtimeId}`,
    [upgradingRuntimeKey],
  );
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
    return readSettingsNotificationPermission().then((permission) => {
      dispatchNotificationState({ type: "set-permission", notificationPermission: permission });
      return permission;
    });
  }, []);

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
  }, [refreshNotificationPermission, sendNotificationProbe]);

  const enableNotifications = useCallback(
    (enabledKeys?: readonly AgentAttentionNotificationSettingKey[]) => {
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
  const isBrowserPage = page === "browser";
  const isChatPage = page === "chat";
  const isEditorPage = page === "editor";
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
  const lspCatalogCategories = useMemo(() => {
    const categories = new Set<ServerLspToolStatus["category"]>();
    for (const tool of lspCatalogTools) {
      if (tool.category !== "custom") {
        categories.add(tool.category);
      }
    }
    return Array.from(categories);
  }, [lspCatalogTools]);
  const lspCatalogCategoryLabel =
    lspCatalogCategory === "all" ? "All categories" : LSP_CATEGORY_LABELS[lspCatalogCategory];

  const refreshLspToolsStatus = useCallback(() => {
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
  }, []);

  const installLspToolsFromSettings = useCallback((reinstall: boolean) => {
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
  }, []);

  const installCustomLspTool = useCallback(
    (input: ServerInstallLspToolInput, installTargetId: string | null = null) => {
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

  const uninstallCatalogTool = useCallback((tool: ServerLspToolStatus) => {
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
  }, []);

  const seedCustomLspForm = useCallback((tool?: ServerLspToolStatus) => {
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
              description="Keep workspace completion helpers off by default to reduce noisy or unwanted code insertions."
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
              status={
                lspToolsError ? (
                  <span className="text-[11px] text-destructive">{lspToolsError}</span>
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
                <div className="rounded-[var(--control-radius)] border border-border/45 bg-background/35 p-2.5">
                  <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                    <div className="relative min-w-0">
                      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                      <Input
                        className="pl-8"
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
                        className="w-full lg:w-44"
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

                <div className="overflow-hidden rounded-[var(--control-radius)] border border-border/45 bg-background/35">
                  {filteredLspCatalogTools.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[12px] text-muted-foreground/62">
                      No language servers match this filter.
                    </div>
                  ) : (
                    <div className="divide-y divide-border/32">
                      {filteredLspCatalogTools.map((tool) => {
                        const isWorking = isInstallingCustomLsp && lspInstallTargetId === tool.id;
                        const versionLabel = resolveLspToolVersionLabel(tool);
                        return (
                          <div
                            key={tool.id}
                            className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
                          >
                            <div className="min-w-0 truncate text-[13px] font-medium text-foreground/92">
                              {tool.label}
                            </div>
                            <div className="justify-self-start text-[11px] font-medium text-muted-foreground/62 sm:justify-self-end">
                              {versionLabel}
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
                              className="justify-self-start sm:justify-self-end"
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
                  <div className="overflow-hidden rounded-[var(--control-radius)] border border-border/45 bg-background/35">
                    <div className="border-b border-border/35 px-3 py-2">
                      <div className="text-[12px] font-medium text-foreground/90">
                        Custom servers
                      </div>
                      <div className="text-[11px] text-muted-foreground/60">
                        Saved package definitions outside the curated catalog.
                      </div>
                    </div>
                    <div className="divide-y divide-border/32">
                      {lspCustomTools.map((tool) => (
                        <div
                          key={tool.id}
                          className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        >
                          <div className="min-w-0 space-y-1">
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
                            <p className="text-[12px] leading-relaxed text-muted-foreground/68">
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
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="overflow-hidden rounded-[var(--control-radius)] border border-border/45 bg-background/35">
                  <div className="flex flex-col gap-2 border-b border-border/35 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="text-[12px] font-medium text-foreground/90">
                        Register custom server
                      </div>
                      <div className="text-[11px] text-muted-foreground/60">
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
                    <div className="space-y-3 p-3">
                      <div className="flex max-w-full gap-1 overflow-x-auto rounded-[var(--control-radius)] border border-border/35 bg-background/45 p-1">
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
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label
                          htmlFor="lsp-custom-package"
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          Package
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          Command
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          Display label
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          Args
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          Language IDs
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72"
                        >
                          File extensions
                          <Input
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
                          className="grid gap-1 text-[11px] font-medium text-muted-foreground/72 sm:col-span-2"
                        >
                          File names
                          <Input
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
                <Input
                  type="number"
                  min={1}
                  max={BROWSER_MAX_MOUNTED_INSTANCES_LIMIT}
                  step={1}
                  className="w-full sm:w-24"
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
                  triggerVariant="outline"
                  triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
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
          >
            <div className="mt-3 flex flex-wrap gap-2">
              {WORKSPACE_SUMMARY_GENERATION_MODE_OPTIONS.map((option) => (
                <Tooltip key={option.value}>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant={
                          settings.workspaceSummaryGenerationMode === option.value
                            ? "default"
                            : "outline"
                        }
                        onClick={() =>
                          updateSettings({
                            workspaceSummaryGenerationMode: option.value,
                          })
                        }
                      >
                        {option.label}
                      </Button>
                    }
                  />
                  <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap">
                    {option.description}
                  </TooltipPopup>
                </Tooltip>
              ))}
            </div>
          </SettingsRow>
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
            customModelErrorByProvider={customModelErrorByProvider}
            customModelInputByProvider={customModelInputByProvider}
            isRefreshingProviders={isRefreshingProviders}
            isUpgradingProvider={isUpgradingProvider}
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

function SettingsPanel(props: { page: SettingsPanelPage }) {
  return useSettingsPanelComponent(props);
}

export function GeneralSettingsPanel() {
  return <SettingsPanel page="general" />;
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

function ProjectWorktreeSetupEditor({ project }: { readonly project: Project }) {
  const setupScript = useMemo(() => setupProjectScript(project.scripts), [project.scripts]);
  const [command, setCommand] = useState(() => setupScript?.command ?? "");
  const [envText, setEnvText] = useState(() => formatProjectScriptEnv(setupScript?.env));
  const [envFilePath, setEnvFilePath] = useState(
    () => setupScript?.envFilePath ?? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCommand(setupScript?.command ?? "");
    setEnvText(formatProjectScriptEnv(setupScript?.env));
    setEnvFilePath(setupScript?.envFilePath ?? DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH);
    setValidationError(null);
  }, [setupScript?.command, setupScript?.env, setupScript?.envFilePath]);

  const saveSetup = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      return;
    }
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setValidationError("Setup command is required.");
      return;
    }

    let parsedEnv: Record<string, string>;
    try {
      parsedEnv = parseProjectScriptEnv(envText);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Invalid environment variables.");
      return;
    }
    let normalizedEnvFilePath: string;
    try {
      normalizedEnvFilePath = normalizeProjectScriptEnvFilePath(envFilePath);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Invalid environment file path.");
      return;
    }

    setSaving(true);
    setValidationError(null);
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
      setValidationError(error instanceof Error ? error.message : "Failed to save setup command.");
    } finally {
      setSaving(false);
    }
  }, [command, envFilePath, envText, project.id, project.scripts, setupScript]);

  const disableSetup = useCallback(async () => {
    if (!setupScript) return;
    const api = readNativeApi();
    if (!api) {
      return;
    }
    setSaving(true);
    setValidationError(null);
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
      setValidationError(error instanceof Error ? error.message : "Failed to disable setup.");
    } finally {
      setSaving(false);
    }
  }, [project.id, project.scripts, setupScript]);

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
    <div className="border-t border-border/35 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground/85">
            <WrenchIcon className="size-3.5 text-muted-foreground" />
            Worktree setup
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
          <p className="mt-1 text-[11px] text-muted-foreground/60">
            Runs after a new worktree is created. Use it for install, bootstrap, or generated files.
          </p>
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
      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground">Command</label>
          <Textarea
            value={command}
            placeholder="bun install"
            size="sm"
            className="font-mono text-[12px]"
            onChange={(event) => setCommand(event.target.value)}
          />
        </div>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Env file</label>
            <Input
              value={envFilePath}
              placeholder=".env"
              className="font-mono text-[12px]"
              onChange={(event) => setEnvFilePath(event.target.value)}
            />
            <p className="text-[10px] text-muted-foreground/60">
              Copied from the project root into each new worktree before setup runs.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Environment</label>
            <Textarea
              value={envText}
              placeholder={"NODE_ENV=development\nAPI_BASE_URL=http://localhost:3000"}
              size="sm"
              className="font-mono text-[12px]"
              onChange={(event) => setEnvText(event.target.value)}
            />
            <p className="text-[10px] text-muted-foreground/60">
              Passed to the setup command and used if the source env file is missing.
            </p>
          </div>
        </div>
      </div>
      {validationError ? (
        <div className="mt-2 text-[11px] text-destructive">{validationError}</div>
      ) : null}
    </div>
  );
}

function ProjectEnvironmentWorktrees({
  project,
  threads,
}: {
  readonly project: Project;
  readonly threads: readonly Thread[];
}) {
  const branchesQuery = useQuery(gitBranchesQueryOptions(project.cwd));
  const navigate = useNavigate();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [worktreeSearch, setWorktreeSearch] = useState("");
  const { deleteWorktreeAndRelatedData } = useThreadActions();
  const projectSshKeyPassphrase =
    settings.gitSshKeyPassphraseByProjectRoot[project.cwd] ??
    DEFAULT_UNIFIED_SETTINGS.gitSshKeyPassphrase;
  const hasProjectSshKeyPassphrase = projectSshKeyPassphrase.trim().length > 0;
  const updateProjectSshKeyPassphrase = useCallback(
    (passphrase: string) => {
      const nextPassphrases = { ...settings.gitSshKeyPassphraseByProjectRoot };
      if (passphrase.trim().length > 0) {
        nextPassphrases[project.cwd] = passphrase;
      } else {
        delete nextPassphrases[project.cwd];
      }
      updateSettings({ gitSshKeyPassphraseByProjectRoot: nextPassphrases });
    },
    [project.cwd, settings.gitSshKeyPassphraseByProjectRoot, updateSettings],
  );
  const projectThreads = useMemo(
    () => threads.filter((thread) => thread.projectId === project.id),
    [project.id, threads],
  );
  const worktrees = useMemo(
    () =>
      getEnvironmentWorktreeEntries({
        branches: branchesQuery.data?.branches ?? [],
        project,
        threads: projectThreads,
      }),
    [branchesQuery.data?.branches, project, projectThreads],
  );
  const filteredWorktrees = useMemo(() => {
    const query = worktreeSearch.trim().toLowerCase();
    if (query.length === 0) {
      return worktrees;
    }
    return worktrees.filter((worktree) => {
      const haystack = [
        worktree.displayName,
        worktree.path,
        ...worktree.branchNames,
        ...worktree.path.split("/"),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [worktreeSearch, worktrees]);

  return (
    <div id={`project-environment-${project.id}`} className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-1 pb-3 sm:px-0">
        <div className="min-w-0">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] leading-snug font-semibold text-foreground/90">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="size-5 shrink-0 text-muted-foreground/70 hover:text-foreground"
              onClick={() => void navigate({ to: "/settings/environment" })}
              aria-label="Back to projects"
            >
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <span className="min-w-0 truncate">{project.name}</span>
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground/55">
            Configure this project's worktree setup command, environment variables, and cleanup.
          </p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={branchesQuery.isFetching}
          onClick={() => void branchesQuery.refetch()}
          aria-label="Refresh worktrees"
        >
          <RefreshCwIcon className={cn("size-3.5", branchesQuery.isFetching && "animate-spin")} />
        </Button>
      </div>
      <ProjectWorktreeSetupEditor project={project} />

      <div className="border-t border-border/35 py-3">
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
            <Input
              type="password"
              className="w-full sm:w-72"
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
      </div>

      <div className="border-t border-border/35 py-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,22rem)] sm:items-start">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[12px] font-medium text-foreground/85">
              <FolderGit2Icon className="size-3.5 text-muted-foreground" />
              Manage worktrees
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground/60">
              Delete unused local worktrees and their linked chats. Active agent worktrees stay
              locked.
            </p>
          </div>
          <div className="relative min-w-0">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
            <Input
              value={worktreeSearch}
              placeholder="Search worktrees, folders, branches"
              className="h-8 pl-8"
              onChange={(event) => setWorktreeSearch(event.target.value)}
            />
          </div>
        </div>

        {branchesQuery.isError ? (
          <div className="mt-3 text-[11px] text-destructive">
            {branchesQuery.error instanceof Error
              ? branchesQuery.error.message
              : "Unable to load worktrees for this project."}
          </div>
        ) : null}

        {branchesQuery.isLoading ? (
          <div className="mt-3 text-[11px] text-muted-foreground/60">Loading worktrees...</div>
        ) : worktrees.length === 0 ? (
          <div className="mt-3 text-[11px] text-muted-foreground/60">
            No additional worktrees detected.
          </div>
        ) : filteredWorktrees.length === 0 ? (
          <div className="mt-3 text-[11px] text-muted-foreground/60">
            No worktrees match that search.
          </div>
        ) : (
          <div className="mt-3 divide-y divide-border/35 border-y border-border/35">
            {filteredWorktrees.map((worktree) => {
              const relatedChatCount = worktree.relatedThreads.length;
              const isActive = worktree.activeThread !== null;
              return (
                <div
                  key={worktree.path}
                  className="grid gap-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/55" />
                    <div className="min-w-0 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-[12px] font-medium text-foreground/90">
                          {worktree.displayName}
                        </span>
                        {isActive ? (
                          <Badge variant="outline" size="sm" className="text-[10px]">
                            In use
                          </Badge>
                        ) : null}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground/50">
                        {worktree.path}
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground/60">
                        <span>{formatCountLabel(worktree.branchNames.length, "branch")}</span>
                        <span>{formatCountLabel(relatedChatCount, "linked chat")}</span>
                        {worktree.branchNames.length > 0 ? (
                          <span className="min-w-0 truncate">
                            {worktree.branchNames.slice(0, 3).join(", ")}
                            {worktree.branchNames.length > 3 ? "..." : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="destructive"
                          className="justify-self-start sm:justify-self-end"
                          disabled={isActive}
                          onClick={() =>
                            void deleteWorktreeAndRelatedData({
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function EnvironmentSettingsPanel() {
  const projects = useStore((store) => store.projects);
  const navigate = useNavigate();
  const [projectSearch, setProjectSearch] = useState("");
  const activeLocalProjects = useMemo(
    () =>
      projects
        .filter((project) => project.archivedAt === null)
        .toSorted(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        ),
    [projects],
  );
  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (query.length === 0) {
      return activeLocalProjects;
    }
    return activeLocalProjects.filter((project) => {
      const haystack = `${project.name}\n${project.cwd}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [activeLocalProjects, projectSearch]);

  return (
    <SettingsPageContainer>
      <div className="min-w-0">
        <div className="px-1 pb-3 sm:px-0">
          <h2 className="flex min-w-0 items-center gap-2 text-[13px] leading-snug font-semibold text-foreground/90">
            <GitForkIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
            <span className="min-w-0 truncate">Environment</span>
          </h2>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground/55">
            Choose a project to configure worktree setup commands, environment variables, and
            cleanup.
          </p>
        </div>
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
          <div>
            <div className="border-y border-border/35 py-2.5">
              <div className="relative max-w-md">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/55" />
                <Input
                  value={projectSearch}
                  placeholder="Search projects"
                  className="h-8 pl-8"
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
              </div>
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
              <div className="divide-y divide-border/35">
                {filteredProjects.map((project) => {
                  const setupScript = setupProjectScript(project.scripts);
                  const environmentCount = Object.keys(setupScript?.env ?? {}).length;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      className="grid w-full gap-3 py-3 text-left transition-colors hover:bg-accent/25 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
                      onClick={() =>
                        void navigate({
                          to: "/settings/project-environment/$projectId",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      <ProjectAvatar project={project} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-foreground/90">
                            {project.name}
                          </span>
                          {setupScript ? (
                            <span className="text-[11px] text-muted-foreground/60">setup</span>
                          ) : null}
                          {environmentCount > 0 ? (
                            <span className="text-[11px] text-muted-foreground/60">
                              {environmentCount} env
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground/55">
                          {project.cwd}
                        </div>
                      </div>
                      <ArrowRightIcon className="size-3.5 text-muted-foreground/60 sm:justify-self-end" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </SettingsPageContainer>
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
          icon={<GitForkIcon className="size-3.5" />}
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
  const threadCountByProjectId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) {
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
  const archivedGroups = useMemo(() => {
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
        <section className="min-w-0 space-y-1.5">
          <div className="flex h-6 min-w-0 items-center justify-between gap-3 pl-2 pr-1.5">
            <h2 className="min-w-0 truncate text-xs font-medium tracking-wider text-muted-foreground uppercase">
              <span className="min-w-0 truncate">Archived</span>
            </h2>
            {archivedGroups.length > 1 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={
                        allGroupsExpanded ? "Collapse all projects" : "Expand all projects"
                      }
                      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
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
            ) : null}
          </div>
          <div className="min-w-0 divide-y divide-border/35">
            {archivedGroups.map((group) => {
              const project = group.project;
              const isOpen = openGroupIds[project.id] !== false;
              const archivedItemCount =
                group.threads.length + (project.archivedAt === null ? 0 : 1);

              return (
                <div key={project.id} className="min-w-0 py-1">
                  <button
                    type="button"
                    className="group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-muted/20"
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
                    <h3 className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/84">
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
                  </button>

                  <Collapsible
                    open={isOpen}
                    onOpenChange={(open) => setGroupOpen(project.id, open)}
                  >
                    <CollapsibleContent>
                      <div className="mt-0.5 space-y-0.5 pl-6">
                        {project.archivedAt !== null ? (
                          <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-0.5 transition-colors hover:bg-muted/14">
                            <div className="min-w-0">
                              <h4 className="truncate text-[12px] font-medium text-foreground/82">
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
                              <ArchiveX className="size-3" />
                              <span>Unarchive</span>
                            </Button>
                          </div>
                        ) : null}

                        {group.threads.map((thread) => (
                          <div
                            key={thread.id}
                            className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-0.5 transition-colors hover:bg-muted/14"
                            onContextMenu={(event) => {
                              event.preventDefault();
                              void handleArchivedThreadContextMenu(thread.id, {
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                          >
                            <div className="min-w-0">
                              <h4 className="truncate text-[12px] font-medium text-foreground/84">
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
        </section>
      )}
    </SettingsPageContainer>
  );
}
