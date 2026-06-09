import {
  DownloadIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useReducer } from "react";
import { ScrollArea } from "~/components/ui/scroll-area";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import type {
  ProviderKind,
  ServerProvider,
  ServerProviderModel,
  ServerProviderRuntime,
} from "@ace/contracts";
import { type UnifiedSettings, DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { formatProviderModelDisplayName, normalizeModelSlug } from "@ace/shared/model";
import { resolveProviderSettings } from "@ace/shared/providerInstances";

import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import {
  PROVIDER_INSTANCE_BADGE_COLORS,
  PROVIDER_INSTANCE_BADGE_ICONS,
  normalizeProviderInstanceBadgeColor,
  normalizeProviderInstanceBadgeIcon,
} from "../../providerInstanceBadgeOptions";
import {
  ProviderInstanceBadge,
  ProviderInstanceBadgeIconGlyph,
} from "../../providerInstanceBadges";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ClaudeAI,
  CursorIcon,
  Gemini,
  GitHubIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
} from "../Icons";
import {
  ProviderLastChecked,
  SettingsInsetPanel,
  SettingsSection,
  SettingResetButton,
  getProviderSummary,
  getProviderVersionLabel,
} from "./SettingsPanelPrimitives";
import {
  SETTINGS_COMPACT_ACTION_BUTTON_CLASS,
  SETTINGS_FIELD_HINT_CLASS,
  SETTINGS_PROVIDER_DETAIL_HEADER_CLASS,
  SETTINGS_PROVIDER_DETAIL_SECTION_CLASS,
  SETTINGS_PROVIDER_DETAIL_STATUS_CLASS,
  SETTINGS_PROVIDER_DETAIL_TITLE_CLASS,
  SETTINGS_PROVIDER_FIELD_LABEL_CLASS,
  SETTINGS_PROVIDER_LAYOUT_CLASS,
  SETTINGS_PROVIDER_LIST_ITEM_CLASS,
  SETTINGS_PROVIDER_LIST_META_CLASS,
  SETTINGS_PROVIDER_LIST_NAME_CLASS,
  SETTINGS_SECTION_CARD_FLUSH_BODY_CLASS,
  SETTINGS_ROW_DESCRIPTION_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from "./settingsUi";

interface ProviderStatusStyle {
  dot: string;
}

interface ProviderSummary {
  headline: ReactNode;
  detail: string | null;
}

type ProviderSettingsEntry = Readonly<{
  accountLabel: string | null;
  badgeColor?: string | undefined;
  badgeIcon?: string | undefined;
  enabled: boolean;
  instanceId?: string | undefined;
  key: string;
  provider: ProviderKind;
  title: string;
}>;

const PROVIDER_LOGO_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  githubCopilot: GitHubIcon,
  cursor: CursorIcon,
  pi: PiIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  githubCopilot: "Copilot",
  cursor: "Cursor",
  pi: "Pi",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const PROVIDER_ENTRY_STATUS_STYLES = {
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

function resolveProviderEntryStatusStyle(
  entry: ProviderSettingsEntry,
  snapshot: ServerProvider | undefined,
): ProviderStatusStyle {
  if (!entry.enabled) {
    return PROVIDER_ENTRY_STATUS_STYLES.disabled;
  }
  const statusKey = snapshot?.status ?? "warning";
  return PROVIDER_ENTRY_STATUS_STYLES[statusKey];
}

export interface ProviderCard {
  provider: ProviderKind;
  title: string;
  binaryPlaceholder: string;
  binaryDescription: ReactNode;
  canUpgradeCli: boolean;
  cliUrlPlaceholder?: string | undefined;
  cliUrlDescription?: ReactNode | undefined;
  homePathKey?: "codexHomePath" | undefined;
  homePlaceholder?: string | undefined;
  homeDescription?: ReactNode | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  providerSnapshots?: ReadonlyArray<ServerProvider> | undefined;
  runtimes?: ReadonlyArray<ServerProviderRuntime> | undefined;
  statusStyle: ProviderStatusStyle;
  summary: ProviderSummary;
  latestVersionLabel: string | null;
  updateStatus: ServerProvider["updateStatus"];
  versionLabel: string | null;
}

type AddProviderStep = "provider" | "setup" | "review";

interface AddProviderDraft {
  badgeColor: string;
  badgeIcon: string;
  binaryPath: string;
  cliUrl: string;
  enabled: boolean;
  label: string;
  launchEnvText: string;
  pathValue: string;
  provider: ProviderKind;
}

type ProviderSettingsSectionState = {
  draftProviders: UnifiedSettings["providers"];
  selectedEntryKey: string;
  addProviderOpen: boolean;
  addProviderStep: AddProviderStep;
  addProviderDraft: AddProviderDraft;
};

type ProviderSettingsSectionAction =
  | { type: "set-draft-providers"; draftProviders: UnifiedSettings["providers"] }
  | { type: "set-selected-entry-key"; selectedEntryKey: string }
  | { type: "set-add-provider-open"; addProviderOpen: boolean }
  | { type: "set-add-provider-step"; addProviderStep: AddProviderStep }
  | { type: "set-add-provider-draft"; addProviderDraft: AddProviderDraft }
  | { type: "update-add-provider-draft"; updater: (draft: AddProviderDraft) => AddProviderDraft };

const ADD_PROVIDER_STEPS: ReadonlyArray<{
  id: AddProviderStep;
  label: string;
}> = [
  { id: "provider", label: "Provider" },
  { id: "setup", label: "Setup" },
  { id: "review", label: "Review" },
];

function providerSettingsSectionStateReducer(
  state: ProviderSettingsSectionState,
  action: ProviderSettingsSectionAction,
): ProviderSettingsSectionState {
  switch (action.type) {
    case "set-draft-providers":
      return state.draftProviders === action.draftProviders
        ? state
        : { ...state, draftProviders: action.draftProviders };
    case "set-selected-entry-key":
      return state.selectedEntryKey === action.selectedEntryKey
        ? state
        : { ...state, selectedEntryKey: action.selectedEntryKey };
    case "set-add-provider-open":
      return state.addProviderOpen === action.addProviderOpen
        ? state
        : { ...state, addProviderOpen: action.addProviderOpen };
    case "set-add-provider-step":
      return state.addProviderStep === action.addProviderStep
        ? state
        : { ...state, addProviderStep: action.addProviderStep };
    case "set-add-provider-draft":
      return state.addProviderDraft === action.addProviderDraft
        ? state
        : { ...state, addProviderDraft: action.addProviderDraft };
    case "update-add-provider-draft": {
      const nextDraft = action.updater(state.addProviderDraft);
      return nextDraft === state.addProviderDraft
        ? state
        : { ...state, addProviderDraft: nextDraft };
    }
  }
}

function resolveCustomModelPlaceholder(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "gpt-6.7-codex-ultra-preview";
    case "claudeAgent":
      return "claude-sonnet-5-0";
    case "gemini":
      return "gemini-2.5-flash";
    case "opencode":
      return "anthropic/claude-3-5-sonnet-20241022";
    default:
      return "gpt-5-mini";
  }
}

function formatLaunchEnv(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseLaunchEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyPart, ...valueParts] = line.split("=");
    if (!keyPart || valueParts.length === 0) continue;
    const key = keyPart.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = valueParts.join("=");
  }
  return env;
}

function instancePathLabel(provider: ProviderKind): string | null {
  switch (provider) {
    case "codex":
      return "CODEX_HOME path";
    case "githubCopilot":
      return null;
    case "claudeAgent":
      return "CLAUDE_CONFIG_DIR path";
    case "cursor":
      return "CURSOR_CONFIG_DIR path";
    case "pi":
      return "PI_CODING_AGENT_DIR path";
    case "opencode":
      return "OPENCODE_CONFIG_DIR path";
    case "gemini":
      return null;
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)]),
    );
  }
  return value;
}

function providerSettingsFingerprint(value: UnifiedSettings["providers"][ProviderKind]): string {
  return JSON.stringify(stableJsonValue(value));
}

function allProviderSettingsFingerprint(value: UnifiedSettings["providers"]): string {
  return JSON.stringify(stableJsonValue(value));
}

function providerEntryKey(provider: ProviderKind, instanceId?: string | null): string {
  return `${provider}:${instanceId && instanceId !== "default" ? instanceId : "default"}`;
}

function createProviderInstanceId(provider: ProviderKind): string {
  return `${provider}-${Date.now().toString(36)}`;
}

function getProviderCardDisplayName(providerCard: ProviderCard): string {
  return PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;
}

function getNextProviderInstanceLabel(
  provider: ProviderKind,
  draftProviders: UnifiedSettings["providers"],
): string {
  const instanceCount = draftProviders[provider].instances.length;
  return instanceCount === 0 ? "Personal" : `Account ${instanceCount + 1}`;
}

function createAddProviderDraft(
  provider: ProviderKind,
  draftProviders: UnifiedSettings["providers"],
): AddProviderDraft {
  return {
    provider,
    label: getNextProviderInstanceLabel(provider, draftProviders),
    enabled: true,
    badgeColor: "slate",
    badgeIcon: "circle",
    binaryPath: draftProviders[provider].binaryPath,
    pathValue: "",
    cliUrl: "",
    launchEnvText: "",
  };
}

function getProviderPathPatch(
  provider: ProviderKind,
  value: string,
): Record<string, string> | null {
  switch (provider) {
    case "codex":
    case "githubCopilot":
      return { homePath: value };
    case "claudeAgent":
    case "cursor":
    case "opencode":
      return { configDir: value };
    case "pi":
      return { agentDir: value };
    case "gemini":
      return null;
  }
}

function buildProviderSettingsEntries(
  providerCards: ReadonlyArray<ProviderCard>,
  draftProviders: UnifiedSettings["providers"],
): ReadonlyArray<ProviderSettingsEntry> {
  return providerCards.flatMap((providerCard) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    const providerDisplayName = getProviderCardDisplayName(providerCard);
    return [
      {
        provider,
        key: providerEntryKey(provider),
        title: providerDisplayName,
        accountLabel: null,
        enabled: providerConfig.enabled,
      },
      ...providerConfig.instances.map((instance) => ({
        provider,
        instanceId: instance.id,
        key: providerEntryKey(provider, instance.id),
        title: `${providerDisplayName} ${instance.label}`,
        accountLabel: instance.label,
        enabled: instance.enabled,
        badgeColor: instance.badgeColor,
        badgeIcon: instance.badgeIcon,
      })),
    ];
  });
}

function resolveProviderCardSnapshot(
  providerCard: ProviderCard,
  providerInstanceId?: string | null,
): ServerProvider | undefined {
  const snapshots = providerCard.providerSnapshots;
  if (!snapshots || snapshots.length === 0) return undefined;
  const normalizedInstanceId =
    providerInstanceId && providerInstanceId !== "default" ? providerInstanceId : undefined;
  return (
    snapshots.find(
      (candidate) =>
        candidate.provider === providerCard.provider &&
        candidate.providerInstanceId === normalizedInstanceId,
    ) ??
    (normalizedInstanceId
      ? undefined
      : snapshots.find(
          (candidate) =>
            candidate.provider === providerCard.provider &&
            candidate.isDefaultProviderInstance === true,
        )) ??
    snapshots.find(
      (candidate) =>
        candidate.provider === providerCard.provider &&
        candidate.providerInstanceId === normalizedInstanceId,
    )
  );
}

function getCliUpdateStatusLabel(
  updateStatus: ServerProvider["updateStatus"],
  latestVersionLabel: string | null,
): string | null {
  if (updateStatus === "up-to-date") {
    return "Up to date";
  }
  if (updateStatus === "update-available") {
    return latestVersionLabel ? `Version ${latestVersionLabel} available` : "Update available";
  }
  return null;
}

function useProviderSettingsSectionComponent({
  customModelErrorByProvider,
  customModelInputByProvider,
  isRefreshingProviders,
  isUpgradingProvider,
  isUpgradingRuntime,
  lastCheckedAt,
  modelListRefs,
  providerCards,
  refreshProviders,
  setCustomModelErrorByProvider,
  setCustomModelInputByProvider,
  settings,
  textGenProvider,
  upgradeProviderCli,
  updateSettings,
}: {
  customModelErrorByProvider: Partial<Record<ProviderKind, string | null>>;
  customModelInputByProvider: Record<ProviderKind, string>;
  isRefreshingProviders: boolean;
  isUpgradingProvider: (provider: ProviderKind) => boolean;
  isUpgradingRuntime: (provider: ProviderKind, runtimeId: string) => boolean;
  lastCheckedAt: string | null;
  modelListRefs: MutableRefObject<Partial<Record<ProviderKind, HTMLDivElement | null>>>;
  providerCards: ReadonlyArray<ProviderCard>;
  refreshProviders: () => void;
  setCustomModelErrorByProvider: Dispatch<
    SetStateAction<Partial<Record<ProviderKind, string | null>>>
  >;
  setCustomModelInputByProvider: Dispatch<SetStateAction<Record<ProviderKind, string>>>;
  settings: UnifiedSettings;
  textGenProvider: ProviderKind;
  upgradeProviderCli: (provider: ProviderKind, runtimeId: string) => void;
  updateSettings: (patch: Partial<UnifiedSettings>) => void;
}) {
  const [sectionState, dispatchSectionState] = useReducer(
    providerSettingsSectionStateReducer,
    undefined,
    (): ProviderSettingsSectionState => ({
      draftProviders: settings.providers,
      selectedEntryKey: providerEntryKey(providerCards[0]?.provider ?? "codex"),
      addProviderOpen: false,
      addProviderStep: "provider",
      addProviderDraft: createAddProviderDraft(
        providerCards[0]?.provider ?? "codex",
        settings.providers,
      ),
    }),
  );
  const { addProviderDraft, addProviderOpen, addProviderStep, draftProviders, selectedEntryKey } =
    sectionState;
  useEffect(() => {
    dispatchSectionState({ type: "set-draft-providers", draftProviders: settings.providers });
  }, [settings.providers]);
  const providerEntries = useMemo(
    () => buildProviderSettingsEntries(providerCards, draftProviders),
    [draftProviders, providerCards],
  );
  useEffect(() => {
    if (providerEntries.some((entry) => entry.key === selectedEntryKey)) {
      return;
    }
    const firstEntry = providerEntries[0];
    if (firstEntry) {
      dispatchSectionState({ type: "set-selected-entry-key", selectedEntryKey: firstEntry.key });
    }
  }, [providerEntries, selectedEntryKey]);

  const hasProviderDraftChanges =
    allProviderSettingsFingerprint(draftProviders) !==
    allProviderSettingsFingerprint(settings.providers);

  const updateProviderConfig = <TProvider extends ProviderKind>(
    provider: TProvider,
    config: UnifiedSettings["providers"][TProvider],
  ) => {
    dispatchSectionState({
      type: "set-draft-providers",
      draftProviders: {
        ...draftProviders,
        [provider]: config,
      },
    });
  };

  const saveProviderDraft = () => {
    const textGenerationProviderSettings = resolveProviderSettings(
      { providers: draftProviders },
      textGenProvider,
      settings.textGenerationModelSelection.providerInstanceId,
    );
    updateSettings({
      providers: draftProviders,
      ...(!textGenerationProviderSettings.enabled
        ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
        : {}),
    });
  };

  const revertProviderDraft = () => {
    dispatchSectionState({ type: "set-draft-providers", draftProviders: settings.providers });
  };

  const addProviderInstance = (draft: AddProviderDraft) => {
    const provider = draft.provider;
    const providerConfig = draftProviders[provider];
    const instanceId = createProviderInstanceId(provider);
    const label = draft.label.trim() || getNextProviderInstanceLabel(provider, draftProviders);
    const binaryPath = draft.binaryPath.trim() || providerConfig.binaryPath;
    const pathValue = draft.pathValue.trim();
    const cliUrl = draft.cliUrl.trim();
    const base = {
      id: instanceId,
      label,
      enabled: draft.enabled,
      badgeColor: normalizeProviderInstanceBadgeColor(draft.badgeColor),
      badgeIcon: normalizeProviderInstanceBadgeIcon(draft.badgeIcon),
      binaryPath,
      customModels: [],
      launchEnv: parseLaunchEnv(draft.launchEnvText),
    };
    const pathPatch = getProviderPathPatch(provider, pathValue);
    const nextInstance =
      provider === "codex"
        ? { ...base, homePath: pathValue }
        : provider === "githubCopilot"
          ? { ...base, homePath: pathPatch?.homePath ?? "", cliUrl }
          : provider === "claudeAgent" || provider === "cursor" || provider === "opencode"
            ? { ...base, configDir: pathPatch?.configDir ?? "" }
            : provider === "pi"
              ? { ...base, agentDir: pathPatch?.agentDir ?? "" }
              : base;

    updateProviderConfig(provider, {
      ...providerConfig,
      instances: [...providerConfig.instances, nextInstance],
    } as UnifiedSettings["providers"][typeof provider]);
    dispatchSectionState({
      type: "set-selected-entry-key",
      selectedEntryKey: providerEntryKey(provider, instanceId),
    });
    dispatchSectionState({ type: "set-add-provider-open", addProviderOpen: false });
  };

  const updateProviderInstance = (
    providerCard: ProviderCard,
    instanceId: string,
    patch: Record<string, unknown>,
  ) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    updateProviderConfig(provider, {
      ...providerConfig,
      instances: providerConfig.instances.map((instance) =>
        instance.id === instanceId ? Object.assign({}, instance, patch) : instance,
      ),
    } as UnifiedSettings["providers"][typeof provider]);
  };

  const removeProviderInstance = (providerCard: ProviderCard, instanceId: string) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    updateProviderConfig(provider, {
      ...providerConfig,
      instances: providerConfig.instances.filter((instance) => instance.id !== instanceId),
    } as UnifiedSettings["providers"][typeof provider]);
    if (selectedEntryKey === providerEntryKey(provider, instanceId)) {
      dispatchSectionState({
        type: "set-selected-entry-key",
        selectedEntryKey: providerEntryKey(provider),
      });
    }
    setCustomModelErrorByProvider((existing) => ({
      ...existing,
      [provider]: null,
    }));
  };

  const addDraftCustomModel = (providerCard: ProviderCard, providerInstanceId?: string) => {
    const provider = providerCard.provider;
    const customModelInput = customModelInputByProvider[provider];
    const providerConfig = draftProviders[provider];
    const providerInstance = providerInstanceId
      ? providerConfig.instances.find((instance) => instance.id === providerInstanceId)
      : undefined;
    const customModels = providerInstance?.customModels ?? providerConfig.customModels;
    const customModelSet = new Set(customModels);
    const normalized = normalizeModelSlug(customModelInput, provider);
    if (!normalized) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "Enter a model slug.",
      }));
      return;
    }
    if (providerCard.models.some((option) => !option.isCustom && option.slug === normalized)) {
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
    if (customModelSet.has(normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That custom model is already added.",
      }));
      return;
    }

    if (providerInstance) {
      updateProviderInstance(providerCard, providerInstance.id, {
        customModels: [...customModels, normalized],
      });
    } else {
      updateProviderConfig(provider, {
        ...providerConfig,
        customModels: [...customModels, normalized],
      } as UnifiedSettings["providers"][typeof provider]);
    }
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
  };

  const removeDraftCustomModel = (
    providerCard: ProviderCard,
    slug: string,
    providerInstanceId?: string,
  ) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    const providerInstance = providerInstanceId
      ? providerConfig.instances.find((instance) => instance.id === providerInstanceId)
      : undefined;
    if (providerInstance) {
      updateProviderInstance(providerCard, providerInstance.id, {
        customModels: providerInstance.customModels.filter((model) => model !== slug),
      });
    } else {
      updateProviderConfig(provider, {
        ...providerConfig,
        customModels: providerConfig.customModels.filter((model) => model !== slug),
      } as UnifiedSettings["providers"][typeof provider]);
    }
    setCustomModelErrorByProvider((existing) => ({
      ...existing,
      [provider]: null,
    }));
  };

  const selectedEntry =
    providerEntries.find((entry) => entry.key === selectedEntryKey) ?? providerEntries[0];
  const selectedProviderCard = selectedEntry
    ? providerCards.find((providerCard) => providerCard.provider === selectedEntry.provider)
    : providerCards[0];

  if (!selectedProviderCard) {
    return (
      <SettingsSection
        title="Providers"
        description="Provider settings will appear after the server reports available CLIs."
      >
        <div className="p-4 text-sm text-muted-foreground">No providers reported.</div>
      </SettingsSection>
    );
  }

  const providerCard = selectedProviderCard;
  const selectedProviderEntry =
    selectedEntry && selectedEntry.provider === providerCard.provider
      ? selectedEntry
      : {
          provider: providerCard.provider,
          key: providerEntryKey(providerCard.provider),
          title: getProviderCardDisplayName(providerCard),
          accountLabel: null,
          enabled: draftProviders[providerCard.provider].enabled,
        };
  const customModelInput = customModelInputByProvider[providerCard.provider];
  const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
  const providerDisplayName = getProviderCardDisplayName(providerCard);
  const ProviderLogo = PROVIDER_LOGO_BY_PROVIDER[providerCard.provider];
  const draftConfig = draftProviders[providerCard.provider];
  const selectedInstance = selectedProviderEntry.instanceId
    ? draftConfig.instances.find((instance) => instance.id === selectedProviderEntry.instanceId)
    : undefined;
  const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider];
  const isDraftDefaultDirty =
    providerSettingsFingerprint(draftConfig) !== providerSettingsFingerprint(defaultProviderConfig);
  const selectedSnapshot = resolveProviderCardSnapshot(
    providerCard,
    selectedProviderEntry.instanceId,
  );
  const selectedVersionLabel =
    getProviderVersionLabel(selectedSnapshot?.version) ?? providerCard.versionLabel;
  const selectedSummary = getProviderSummary(selectedSnapshot);
  const selectedStatusStyle = resolveProviderEntryStatusStyle(
    selectedProviderEntry,
    selectedSnapshot,
  );
  const selectedCustomModels = selectedInstance?.customModels ?? draftConfig.customModels;
  const selectedEntryConfig = (selectedInstance ?? draftConfig) as Record<string, unknown>;
  const selectedPathLabel = instancePathLabel(providerCard.provider);
  const selectedPathValue =
    typeof selectedEntryConfig.homePath === "string"
      ? selectedEntryConfig.homePath
      : typeof selectedEntryConfig.configDir === "string"
        ? selectedEntryConfig.configDir
        : typeof selectedEntryConfig.agentDir === "string"
          ? selectedEntryConfig.agentDir
          : "";
  const selectedCliUrlValue =
    typeof selectedEntryConfig.cliUrl === "string" ? selectedEntryConfig.cliUrl : "";
  const selectedLaunchEnv =
    selectedEntryConfig.launchEnv &&
    typeof selectedEntryConfig.launchEnv === "object" &&
    !Array.isArray(selectedEntryConfig.launchEnv)
      ? (selectedEntryConfig.launchEnv as Record<string, string>)
      : {};
  const updateSelectedEntryConfig = (patch: Record<string, unknown>) => {
    if (selectedInstance) {
      updateProviderInstance(providerCard, selectedInstance.id, patch);
      return;
    }
    updateProviderConfig(providerCard.provider, {
      ...draftConfig,
      ...patch,
    } as UnifiedSettings["providers"][typeof providerCard.provider]);
  };
  const baseModels = selectedSnapshot?.models ?? providerCard.models;
  const selectedCustomModelSet = new Set(selectedCustomModels);
  const displayedModels = baseModels.filter(
    (model) => !model.isCustom || selectedCustomModelSet.has(model.slug),
  );
  for (const slug of selectedCustomModels) {
    if (displayedModels.some((model) => model.slug === slug)) continue;
    displayedModels.push({
      slug,
      name: formatProviderModelDisplayName(providerCard.provider, slug),
      isCustom: true,
      capabilities: null,
    });
  }
  const addProviderCard =
    providerCards.find((candidate) => candidate.provider === addProviderDraft.provider) ??
    providerCards[0];
  const AddProviderLogo = addProviderCard
    ? PROVIDER_LOGO_BY_PROVIDER[addProviderCard.provider]
    : PROVIDER_LOGO_BY_PROVIDER.codex;
  const addProviderDisplayName = addProviderCard
    ? getProviderCardDisplayName(addProviderCard)
    : PROVIDER_DISPLAY_NAMES[addProviderDraft.provider];
  const addProviderPathLabel = instancePathLabel(addProviderDraft.provider);
  const addProviderLaunchEnvCount = Object.keys(
    parseLaunchEnv(addProviderDraft.launchEnvText),
  ).length;
  const addProviderCurrentStepIndex = ADD_PROVIDER_STEPS.findIndex(
    (step) => step.id === addProviderStep,
  );
  const canCreateProviderDraft = addProviderDraft.label.trim().length > 0;
  const resetAddProviderDialog = (provider: ProviderKind) => {
    dispatchSectionState({
      type: "set-add-provider-draft",
      addProviderDraft: createAddProviderDraft(provider, draftProviders),
    });
    dispatchSectionState({ type: "set-add-provider-step", addProviderStep: "provider" });
  };
  const openAddProviderDialog = () => {
    resetAddProviderDialog(selectedProviderEntry.provider);
    dispatchSectionState({ type: "set-add-provider-open", addProviderOpen: true });
  };
  const closeAddProviderDialog = () => {
    dispatchSectionState({ type: "set-add-provider-open", addProviderOpen: false });
  };
  const selectAddProvider = (provider: ProviderKind) => {
    dispatchSectionState({
      type: "set-add-provider-draft",
      addProviderDraft: createAddProviderDraft(provider, draftProviders),
    });
  };
  const goToPreviousAddProviderStep = () => {
    const previousStep = ADD_PROVIDER_STEPS[Math.max(0, addProviderCurrentStepIndex - 1)];
    if (previousStep) {
      dispatchSectionState({ type: "set-add-provider-step", addProviderStep: previousStep.id });
    }
  };
  const goToNextAddProviderStep = () => {
    const nextStep =
      ADD_PROVIDER_STEPS[Math.min(ADD_PROVIDER_STEPS.length - 1, addProviderCurrentStepIndex + 1)];
    if (nextStep) {
      dispatchSectionState({ type: "set-add-provider-step", addProviderStep: nextStep.id });
    }
  };
  const confirmRemoveSelectedProviderInstance = async () => {
    if (!selectedInstance) {
      return;
    }
    const instanceLabel = selectedInstance.label.trim() || "Personal";
    const confirmed = await ensureNativeApi().dialogs.confirm(
      `Remove ${providerDisplayName} (${instanceLabel})?\nThis removes the provider account from your settings draft.\nSave to apply the change.`,
    );
    if (!confirmed) {
      return;
    }
    removeProviderInstance(providerCard, selectedInstance.id);
  };

  return (
    <>
      <SettingsSection
        title="Providers"
        description="Configure provider CLIs, accounts, launch paths, and custom models."
        bodyClassName={SETTINGS_SECTION_CARD_FLUSH_BODY_CLASS}
        contentClassName="[&_[data-slot=input-control]]:text-[12px] [&_[data-slot=input]]:text-[12px] [&_[data-slot=textarea]]:text-[12px]"
      >
        <div className={SETTINGS_PROVIDER_LAYOUT_CLASS} data-provider-settings-layout="true">
          <aside className="flex min-h-0 flex-col bg-muted/[0.03] lg:max-h-[calc(100vh-12rem)]">
            <div className="border-b border-border px-2.5 py-2.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full gap-1 text-xs"
                onClick={openAddProviderDialog}
                data-provider-settings-add-provider="true"
              >
                <PlusIcon className="size-3" />
                Add provider
              </Button>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-0.5 p-1.5">
                {providerEntries.map((entry) => {
                  const entryCard = providerCards.find(
                    (candidate) => candidate.provider === entry.provider,
                  );
                  if (!entryCard) return null;
                  const EntryLogo = PROVIDER_LOGO_BY_PROVIDER[entry.provider];
                  const entrySnapshot = resolveProviderCardSnapshot(entryCard, entry.instanceId);
                  const entryStatusStyle = resolveProviderEntryStatusStyle(entry, entrySnapshot);
                  const entryDisplayName = getProviderCardDisplayName(entryCard);
                  const isSelected = entry.key === selectedEntryKey;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      data-active={isSelected ? "true" : undefined}
                      className={cn(
                        SETTINGS_PROVIDER_LIST_ITEM_CLASS,
                        isSelected
                          ? "bg-foreground/[0.08] text-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                      )}
                      onClick={() =>
                        dispatchSectionState({
                          type: "set-selected-entry-key",
                          selectedEntryKey: entry.key,
                        })
                      }
                    >
                      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-foreground/[0.06]">
                        <EntryLogo className="size-3" />
                        {entry.instanceId && entry.badgeColor && entry.badgeIcon ? (
                          <ProviderInstanceBadge
                            color={entry.badgeColor}
                            icon={entry.badgeIcon}
                            className="absolute -bottom-0.5 -right-0.5 size-3 border-[1.5px] p-[1px]"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={SETTINGS_PROVIDER_LIST_NAME_CLASS}>{entryDisplayName}</span>
                        <span className={SETTINGS_PROVIDER_LIST_META_CLASS}>
                          {entry.accountLabel ?? "Default"}
                          {!entry.enabled ? " · Off" : ""}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          entryStatusStyle.dot,
                          !entry.enabled && "opacity-50",
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </aside>

          <div className="min-w-0">
            <div className={SETTINGS_PROVIDER_DETAIL_HEADER_CLASS}>
              <div className="flex min-w-0 items-start gap-3">
                <span className="relative flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-foreground/[0.06]">
                  <ProviderLogo className="size-3.5" />
                  {selectedInstance ? (
                    <ProviderInstanceBadge
                      color={selectedInstance.badgeColor}
                      icon={selectedInstance.badgeIcon}
                      className="absolute -bottom-0.5 -right-0.5 size-3.5 border-[1.5px] p-[1px]"
                    />
                  ) : null}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <h3 className={SETTINGS_PROVIDER_DETAIL_TITLE_CLASS}>{providerDisplayName}</h3>
                    {selectedVersionLabel ? (
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
                        {selectedVersionLabel}
                      </span>
                    ) : null}
                    {isDraftDefaultDirty ? (
                      <SettingResetButton
                        label={`${providerDisplayName} provider settings`}
                        onClick={() => {
                          updateProviderConfig(providerCard.provider, defaultProviderConfig);
                          setCustomModelErrorByProvider((existing) => ({
                            ...existing,
                            [providerCard.provider]: null,
                          }));
                        }}
                      />
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5",
                      SETTINGS_PROVIDER_DETAIL_STATUS_CLASS,
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn("size-1.5 rounded-full", selectedStatusStyle.dot)}
                    />
                    <span>{selectedSummary.headline}</span>
                    {selectedSummary.detail ? (
                      <span className="text-muted-foreground/60">· {selectedSummary.detail}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
                {hasProviderDraftChanges ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon"
                            variant="ghost"
                            className={SETTINGS_COMPACT_ACTION_BUTTON_CLASS}
                            onClick={revertProviderDraft}
                            aria-label="Revert provider changes"
                          >
                            <Undo2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Revert changes</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon"
                            variant="ghost"
                            className={SETTINGS_COMPACT_ACTION_BUTTON_CLASS}
                            onClick={saveProviderDraft}
                            aria-label="Save provider changes"
                          >
                            <SaveIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Save changes</TooltipPopup>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon"
                          variant="ghost"
                          className={SETTINGS_COMPACT_ACTION_BUTTON_CLASS}
                          disabled={isRefreshingProviders}
                          onClick={() => void refreshProviders()}
                          aria-label="Check provider status"
                        >
                          <RefreshCwIcon
                            className={cn(isRefreshingProviders && "animate-spin")}
                          />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">
                      {isRefreshingProviders ? "Checking..." : "Check status"}
                    </TooltipPopup>
                  </Tooltip>
                )}
                <Switch
                  checked={selectedInstance?.enabled ?? draftConfig.enabled}
                  onCheckedChange={(checked) => {
                    updateSelectedEntryConfig({ enabled: Boolean(checked) });
                  }}
                  aria-label={`Enable ${selectedProviderEntry.title}`}
                />
              </div>
            </div>

            {selectedInstance ? (
              <div className={SETTINGS_PROVIDER_DETAIL_SECTION_CLASS}>
                <div className="flex items-center justify-between gap-2">
                  <p className={SETTINGS_SECTION_TITLE_CLASS}>Identity</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => void confirmRemoveSelectedProviderInstance()}
                  >
                    <Trash2Icon className="size-3" />
                    Remove
                  </Button>
                </div>
                <div className="mt-2.5 space-y-2.5">
                  <div>
                    <label
                      className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}
                      htmlFor={`provider-instance-${providerCard.provider}-name`}
                    >
                      Name
                    </label>
                    <Input
                      id={`provider-instance-${providerCard.provider}-name`}
                      className="mt-1 w-full"
                      value={selectedInstance.label}
                      onChange={(event) =>
                        updateProviderInstance(providerCard, selectedInstance.id, {
                          label: event.target.value,
                        })
                      }
                      placeholder="Personal"
                    />
                  </div>
                  <div>
                    <p className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}>Icon</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {PROVIDER_INSTANCE_BADGE_ICONS.map((badgeIcon) => {
                        const selectedIcon =
                          normalizeProviderInstanceBadgeIcon(selectedInstance.badgeIcon) ===
                          badgeIcon.value;
                        return (
                          <Tooltip key={badgeIcon.value}>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "flex size-7 items-center justify-center rounded-[var(--control-radius)] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
                                    selectedIcon && "bg-foreground/[0.08] text-foreground",
                                  )}
                                  onClick={() =>
                                    updateProviderInstance(providerCard, selectedInstance.id, {
                                      badgeIcon: badgeIcon.value,
                                    })
                                  }
                                  aria-label={`Use ${badgeIcon.label} badge icon`}
                                >
                                  <ProviderInstanceBadgeIconGlyph
                                    icon={badgeIcon.value}
                                    className="size-3.5"
                                  />
                                </button>
                              }
                            />
                            <TooltipPopup side="top">{badgeIcon.label}</TooltipPopup>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}>Color</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {PROVIDER_INSTANCE_BADGE_COLORS.map((badgeColor) => {
                        const selectedColor =
                          normalizeProviderInstanceBadgeColor(selectedInstance.badgeColor) ===
                          badgeColor.value;
                        return (
                          <Tooltip key={badgeColor.value}>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "flex size-7 items-center justify-center rounded-full border border-transparent transition-colors hover:border-border/70",
                                    selectedColor && "border-foreground/75",
                                  )}
                                  onClick={() =>
                                    updateProviderInstance(providerCard, selectedInstance.id, {
                                      badgeColor: badgeColor.value,
                                    })
                                  }
                                  aria-label={`Use ${badgeColor.label} badge color`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className="size-3.5 rounded-full"
                                    style={{ backgroundColor: badgeColor.hex }}
                                  />
                                </button>
                              }
                            />
                            <TooltipPopup side="top">{badgeColor.label}</TooltipPopup>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className={SETTINGS_PROVIDER_DETAIL_SECTION_CLASS}>
              <p className={SETTINGS_SECTION_TITLE_CLASS}>Launch</p>
              <div className="mt-2.5 space-y-2.5">
                <div>
                  <label
                    className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}
                    htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                  >
                    Binary path
                  </label>
                  <Input
                    id={`provider-install-${providerCard.provider}-binary-path`}
                    className="mt-1 w-full"
                    value={String(selectedEntryConfig.binaryPath ?? "")}
                    onChange={(event) =>
                      updateSelectedEntryConfig({
                        binaryPath: event.target.value,
                      })
                    }
                    placeholder={providerCard.binaryPlaceholder}
                    spellCheck={false}
                  />
                  {providerCard.binaryDescription ? (
                    <p className={SETTINGS_FIELD_HINT_CLASS}>{providerCard.binaryDescription}</p>
                  ) : null}
                </div>

                {providerCard.provider === "githubCopilot" ? (
                  <div>
                    <label
                      className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}
                      htmlFor={`provider-install-${providerCard.provider}-cli-url`}
                    >
                      CLI server URL
                    </label>
                    <Input
                      id={`provider-install-${providerCard.provider}-cli-url`}
                      className="mt-1 w-full"
                      value={selectedCliUrlValue}
                      onChange={(event) =>
                        updateSelectedEntryConfig({
                          cliUrl: event.target.value,
                        })
                      }
                      placeholder={providerCard.cliUrlPlaceholder}
                      spellCheck={false}
                    />
                    {providerCard.cliUrlDescription ? (
                      <p className={SETTINGS_FIELD_HINT_CLASS}>{providerCard.cliUrlDescription}</p>
                    ) : null}
                  </div>
                ) : null}

                {selectedPathLabel ? (
                  <div>
                    <label
                      className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}
                      htmlFor={`provider-install-${providerCard.provider}-path`}
                    >
                      {selectedPathLabel}
                    </label>
                    <Input
                      id={`provider-install-${providerCard.provider}-path`}
                      className="mt-1 w-full"
                      value={selectedPathValue}
                      onChange={(event) => {
                        const pathKey =
                          providerCard.provider === "codex" ||
                          providerCard.provider === "githubCopilot"
                            ? "homePath"
                            : providerCard.provider === "pi"
                              ? "agentDir"
                              : "configDir";
                        updateSelectedEntryConfig({ [pathKey]: event.target.value });
                      }}
                      placeholder={providerCard.homePlaceholder}
                      spellCheck={false}
                    />
                    {providerCard.homeDescription ? (
                      <p className={SETTINGS_FIELD_HINT_CLASS}>{providerCard.homeDescription}</p>
                    ) : null}
                  </div>
                ) : null}

                <div>
                  <label
                    className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}
                    htmlFor={`provider-install-${providerCard.provider}-launch-env`}
                  >
                    Launch env
                  </label>
                  <Textarea
                    id={`provider-install-${providerCard.provider}-launch-env`}
                    className="mt-1 w-full"
                    size="sm"
                    value={formatLaunchEnv(selectedLaunchEnv)}
                    onChange={(event) =>
                      updateSelectedEntryConfig({
                        launchEnv: parseLaunchEnv(event.target.value),
                      })
                    }
                    placeholder={
                      providerCard.provider === "gemini" ? "GEMINI_API_KEY=..." : "KEY=value"
                    }
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>

            {providerCard.runtimes && providerCard.runtimes.length > 0 ? (
              <div className={SETTINGS_PROVIDER_DETAIL_SECTION_CLASS}>
                <p className={SETTINGS_SECTION_TITLE_CLASS}>Runtimes</p>
                <SettingsInsetPanel className="mt-3 overflow-hidden">
                  {providerCard.runtimes.map((runtime) => {
                    const upgradingRuntime = isUpgradingRuntime(providerCard.provider, runtime.id);
                    const runtimeLatestVersionLabel = getProviderVersionLabel(runtime.latestVersion);
                    const runtimeUpdateStatusLabel = getCliUpdateStatusLabel(
                      runtime.updateStatus,
                      runtimeLatestVersionLabel,
                    );
                    const canUpdateRuntime =
                      runtime.upgradeable && runtime.updateStatus === "update-available";
                    return (
                      <div
                        key={`${providerCard.provider}:${runtime.id}`}
                        className="flex items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] font-medium text-foreground">
                              {runtime.label}
                            </span>
                            {runtime.version ? (
                              <code className="text-xs text-muted-foreground">{runtime.version}</code>
                            ) : null}
                            {runtimeUpdateStatusLabel ? (
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  runtime.updateStatus === "update-available"
                                    ? "text-warning-foreground"
                                    : "text-muted-foreground",
                                )}
                              >
                                {runtimeUpdateStatusLabel}
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {runtime.binaryPath}
                          </div>
                        </div>
                        {canUpdateRuntime ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
                                  disabled={upgradingRuntime}
                                  onClick={() =>
                                    upgradeProviderCli(providerCard.provider, runtime.id)
                                  }
                                  aria-label={`Update ${runtime.label}`}
                                >
                                  {upgradingRuntime ? (
                                    <LoaderIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <DownloadIcon className="size-3.5" />
                                  )}
                                </Button>
                              }
                            />
                            <TooltipPopup side="top">Update {runtime.label}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                    );
                  })}
                </SettingsInsetPanel>
              </div>
            ) : null}

            <div className={cn(SETTINGS_PROVIDER_DETAIL_SECTION_CLASS, "pb-4")}>
              <div className="flex items-baseline justify-between gap-3">
                <p className={SETTINGS_SECTION_TITLE_CLASS}>Models</p>
                <p className="text-[10px] text-muted-foreground/60">
                  {displayedModels.length} available, {selectedCustomModels.length} custom.
                </p>
              </div>
              <div className="mt-2.5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(10rem,12.5rem)]">
                <SettingsInsetPanel className="overflow-hidden">
                  <ScrollArea
                    ref={(element) => {
                      modelListRefs.current[providerCard.provider] = element;
                    }}
                    className="max-h-64"
                  >
                    {displayedModels.map((model) => {
                      const caps = model.capabilities;
                      const capLabels: string[] = [];
                      if (caps?.supportsFastMode) capLabels.push("Fast");
                      if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                      if (caps?.reasoningEffortLevels && caps.reasoningEffortLevels.length > 0) {
                        capLabels.push("Reasoning");
                      }
                      const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                      return (
                        <div
                          key={`${providerCard.provider}:${model.slug}`}
                          className="flex min-h-8 items-center gap-2 border-b border-border/40 px-2.5 py-1.5 last:border-b-0"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                            {model.name}
                          </span>
                          {capLabels.map((label) => (
                            <span
                              key={label}
                              className="hidden rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-flex"
                            >
                              {label}
                            </span>
                          ))}
                          {hasDetails ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    className="shrink-0 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                                    aria-label={`Details for ${model.name}`}
                                  >
                                    <InfoIcon className="size-3.5" />
                                  </button>
                                }
                              />
                              <TooltipPopup side="top" className="max-w-56">
                                <code className="block text-xs text-foreground">{model.slug}</code>
                              </TooltipPopup>
                            </Tooltip>
                          ) : null}
                          {model.isCustom ? (
                            <button
                              type="button"
                              className="rounded-full border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                              aria-label={`Remove ${model.slug}`}
                              onClick={() =>
                                removeDraftCustomModel(
                                  providerCard,
                                  model.slug,
                                  selectedProviderEntry.instanceId,
                                )
                              }
                            >
                              custom
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </ScrollArea>
                </SettingsInsetPanel>

                <div className="min-w-0">
                  <p className={SETTINGS_PROVIDER_FIELD_LABEL_CLASS}>Add custom model</p>
                  <p className={cn(SETTINGS_ROW_DESCRIPTION_CLASS, "mt-0.5 text-[11px]")}>
                    Custom model slugs are saved with this provider after Save.
                  </p>
                  <div className="mt-2.5 space-y-2">
                    <Input
                      id={`custom-model-${providerCard.provider}`}
                      className="w-full"
                      value={customModelInput}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCustomModelInputByProvider((existing) => ({
                          ...existing,
                          [providerCard.provider]: value,
                        }));
                        if (customModelError) {
                          setCustomModelErrorByProvider((existing) => ({
                            ...existing,
                            [providerCard.provider]: null,
                          }));
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addDraftCustomModel(providerCard, selectedProviderEntry.instanceId);
                      }}
                      placeholder={resolveCustomModelPlaceholder(providerCard.provider)}
                      spellCheck={false}
                    />
                    <Button
                      className="h-7 w-full gap-1 text-xs"
                      variant="outline"
                      onClick={() =>
                        addDraftCustomModel(providerCard, selectedProviderEntry.instanceId)
                      }
                    >
                      <PlusIcon className="size-3.5" />
                      Add model
                    </Button>
                    {customModelError ? (
                      <p className="text-xs text-destructive">{customModelError}</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>
      <Dialog
        onOpenChange={(open) => {
          dispatchSectionState({ type: "set-add-provider-open", addProviderOpen: open });
          if (!open) {
            dispatchSectionState({ type: "set-add-provider-step", addProviderStep: "provider" });
          }
        }}
        open={addProviderOpen}
      >
        <DialogPopup className="max-w-2xl" data-provider-settings-add-provider-modal="true">
          <DialogHeader className="gap-2 px-4 py-3 sm:px-5 sm:py-4">
            <div className="flex items-center gap-2">
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-foreground/[0.06]">
                <AddProviderLogo className="size-4" />
                {addProviderStep !== "provider" ? (
                  <ProviderInstanceBadge
                    color={addProviderDraft.badgeColor}
                    icon={addProviderDraft.badgeIcon}
                    className="absolute -bottom-1 -right-1 size-4 border-[1.5px] p-[2px]"
                  />
                ) : null}
              </span>
              <div className="min-w-0">
                <DialogTitle>Add provider</DialogTitle>
                <DialogDescription className="text-xs">
                  {addProviderStep === "provider"
                    ? "Choose a provider type."
                    : addProviderStep === "setup"
                      ? "Set up the account."
                      : "Create a draft account."}
                </DialogDescription>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1 py-1">
              {ADD_PROVIDER_STEPS.map((step, index) => {
                const isActive = step.id === addProviderStep;
                const isComplete = index < addProviderCurrentStepIndex;
                return (
                  <button
                    key={step.id}
                    type="button"
                    className={cn(
                      "h-7 rounded-[calc(var(--control-radius)-2px)] px-2 text-xs transition-colors",
                      isActive
                        ? "bg-foreground/[0.08] text-foreground"
                        : isComplete
                          ? "text-foreground/80 hover:bg-foreground/[0.04]"
                          : "text-muted-foreground/60",
                    )}
                    onClick={() => {
                      if (index <= addProviderCurrentStepIndex) {
                        dispatchSectionState({
                          type: "set-add-provider-step",
                          addProviderStep: step.id,
                        });
                      }
                    }}
                    disabled={index > addProviderCurrentStepIndex}
                  >
                    {step.label}
                  </button>
                );
              })}
            </div>
          </DialogHeader>

          <DialogPanel className="p-4 sm:p-5">
            {addProviderStep === "provider" ? (
              <div className="flex flex-col gap-3" data-provider-setup-step="provider">
                {providerCards.map((candidate) => {
                  const CandidateLogo = PROVIDER_LOGO_BY_PROVIDER[candidate.provider];
                  const candidateName = getProviderCardDisplayName(candidate);
                  const isSelected = candidate.provider === addProviderDraft.provider;
                  const instanceCount = draftProviders[candidate.provider].instances.length;
                  return (
                    <button
                      key={`provider-setup:${candidate.provider}`}
                      type="button"
                      className={cn(
                        "flex min-w-0 items-center gap-3 rounded-[var(--control-radius)] px-3 py-2.5 text-left transition-colors",
                        isSelected
                          ? "bg-foreground/[0.07] text-foreground"
                          : "bg-transparent text-muted-foreground hover:bg-foreground/[0.04]",
                      )}
                      onClick={() => selectAddProvider(candidate.provider)}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-foreground/[0.06]">
                        <CandidateLogo className="size-4.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{candidateName}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground/60">
                          {instanceCount === 0
                            ? "Default only"
                            : `${instanceCount} account${instanceCount === 1 ? "" : "s"}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {addProviderStep === "setup" ? (
              <div className="space-y-4" data-provider-setup-step="setup">
                <div className="flex flex-col gap-3">
                  <label htmlFor="add-provider-name" className="block">
                    <span className="text-[11px] font-medium text-foreground/75">Name</span>
                    <Input
                      id="add-provider-name"
                      className="mt-1"
                      value={addProviderDraft.label}
                      onChange={(event) =>
                        dispatchSectionState({
                          type: "update-add-provider-draft",
                          updater: (draft) => ({
                            ...draft,
                            label: event.target.value,
                          }),
                        })
                      }
                      placeholder="Personal"
                    />
                  </label>
                  <div className="flex items-end justify-between gap-3 py-2">
                    <span className="text-xs font-medium text-foreground/80">Enabled</span>
                    <Switch
                      id="add-provider-enabled"
                      checked={addProviderDraft.enabled}
                      onCheckedChange={(checked) =>
                        dispatchSectionState({
                          type: "update-add-provider-draft",
                          updater: (draft) => ({
                            ...draft,
                            enabled: Boolean(checked),
                          }),
                        })
                      }
                      aria-label="Enable new provider account"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-foreground/75">Badge</div>
                    <div className="flex flex-wrap items-center gap-1 py-1">
                      {PROVIDER_INSTANCE_BADGE_ICONS.map((badgeIcon) => {
                        const selectedIcon =
                          normalizeProviderInstanceBadgeIcon(addProviderDraft.badgeIcon) ===
                          badgeIcon.value;
                        return (
                          <Tooltip key={badgeIcon.value}>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "flex size-7 items-center justify-center rounded-[calc(var(--control-radius)-3px)] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
                                    selectedIcon && "bg-foreground/[0.08] text-foreground",
                                  )}
                                  onClick={() =>
                                    dispatchSectionState({
                                      type: "update-add-provider-draft",
                                      updater: (draft) => ({
                                        ...draft,
                                        badgeIcon: badgeIcon.value,
                                      }),
                                    })
                                  }
                                  aria-label={`Use ${badgeIcon.label} badge icon`}
                                >
                                  <ProviderInstanceBadgeIconGlyph
                                    icon={badgeIcon.value}
                                    className="size-3.5"
                                  />
                                </button>
                              }
                            />
                            <TooltipPopup side="top">{badgeIcon.label}</TooltipPopup>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-[11px] font-medium text-foreground/75">Color</div>
                    <div className="flex flex-wrap items-center gap-1 py-1">
                      {PROVIDER_INSTANCE_BADGE_COLORS.map((badgeColor) => {
                        const selectedColor =
                          normalizeProviderInstanceBadgeColor(addProviderDraft.badgeColor) ===
                          badgeColor.value;
                        return (
                          <Tooltip key={badgeColor.value}>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className={cn(
                                    "flex size-7 items-center justify-center rounded-full border border-transparent transition-colors hover:border-border/70",
                                    selectedColor && "border-foreground/75",
                                  )}
                                  onClick={() =>
                                    dispatchSectionState({
                                      type: "update-add-provider-draft",
                                      updater: (draft) => ({
                                        ...draft,
                                        badgeColor: badgeColor.value,
                                      }),
                                    })
                                  }
                                  aria-label={`Use ${badgeColor.label} badge color`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className="size-3.5 rounded-full"
                                    style={{ backgroundColor: badgeColor.hex }}
                                  />
                                </button>
                              }
                            />
                            <TooltipPopup side="top">{badgeColor.label}</TooltipPopup>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <label htmlFor="add-provider-binary-path" className="block">
                    <span className="text-[11px] font-medium text-foreground/75">Binary path</span>
                    <Input
                      id="add-provider-binary-path"
                      className="mt-1"
                      value={addProviderDraft.binaryPath}
                      onChange={(event) =>
                        dispatchSectionState({
                          type: "update-add-provider-draft",
                          updater: (draft) => ({
                            ...draft,
                            binaryPath: event.target.value,
                          }),
                        })
                      }
                      placeholder={addProviderCard?.binaryPlaceholder}
                      spellCheck={false}
                    />
                  </label>

                  {addProviderPathLabel ? (
                    <label htmlFor="add-provider-path" className="block">
                      <span className="text-[11px] font-medium text-foreground/75">
                        {addProviderPathLabel}
                      </span>
                      <Input
                        id="add-provider-path"
                        className="mt-1"
                        value={addProviderDraft.pathValue}
                        onChange={(event) =>
                          dispatchSectionState({
                            type: "update-add-provider-draft",
                            updater: (draft) => ({
                              ...draft,
                              pathValue: event.target.value,
                            }),
                          })
                        }
                        placeholder={addProviderCard?.homePlaceholder}
                        spellCheck={false}
                      />
                    </label>
                  ) : null}

                  {addProviderDraft.provider === "githubCopilot" ? (
                    <label htmlFor="add-provider-cli-url" className="block">
                      <span className="text-[11px] font-medium text-foreground/75">
                        CLI server URL
                      </span>
                      <Input
                        id="add-provider-cli-url"
                        className="mt-1"
                        value={addProviderDraft.cliUrl}
                        onChange={(event) =>
                          dispatchSectionState({
                            type: "update-add-provider-draft",
                            updater: (draft) => ({
                              ...draft,
                              cliUrl: event.target.value,
                            }),
                          })
                        }
                        placeholder={addProviderCard?.cliUrlPlaceholder}
                        spellCheck={false}
                      />
                    </label>
                  ) : null}
                </div>

                <label htmlFor="add-provider-launch-env" className="block">
                  <span className="text-[11px] font-medium text-foreground/75">Launch env</span>
                  <Textarea
                    id="add-provider-launch-env"
                    className="mt-1"
                    size="sm"
                    value={addProviderDraft.launchEnvText}
                    onChange={(event) =>
                      dispatchSectionState({
                        type: "update-add-provider-draft",
                        updater: (draft) => ({
                          ...draft,
                          launchEnvText: event.target.value,
                        }),
                      })
                    }
                    placeholder={
                      addProviderDraft.provider === "gemini" ? "GEMINI_API_KEY=..." : "KEY=value"
                    }
                    spellCheck={false}
                  />
                </label>
              </div>
            ) : null}

            {addProviderStep === "review" ? (
              <div className="space-y-3" data-provider-setup-step="review">
                <div className="flex items-center gap-3 py-3">
                  <span className="relative flex size-10 shrink-0 items-center justify-center rounded-[var(--control-radius)] bg-foreground/[0.06]">
                    <AddProviderLogo className="size-5" />
                    <ProviderInstanceBadge
                      color={addProviderDraft.badgeColor}
                      icon={addProviderDraft.badgeIcon}
                      className="absolute -bottom-1 -right-1 size-4 border-[1.5px]"
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {addProviderDisplayName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground/65">
                      {addProviderDraft.label.trim() || "Unnamed account"}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 text-xs">
                  <div className="rounded-[var(--control-radius)] bg-foreground/[0.025] px-3 py-2">
                    <div className="text-muted-foreground/60">Binary</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderDraft.binaryPath.trim() || addProviderCard?.binaryPlaceholder}
                    </div>
                  </div>
                  <div className="rounded-[var(--control-radius)] bg-foreground/[0.025] px-3 py-2">
                    <div className="text-muted-foreground/60">State path</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderPathLabel
                        ? addProviderDraft.pathValue.trim() || "Default"
                        : "Provider default"}
                    </div>
                  </div>
                  <div className="rounded-[var(--control-radius)] bg-foreground/[0.025] px-3 py-2">
                    <div className="text-muted-foreground/60">Env</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderLaunchEnvCount === 0
                        ? "None"
                        : `${addProviderLaunchEnvCount} variable${
                            addProviderLaunchEnvCount === 1 ? "" : "s"
                          }`}
                    </div>
                  </div>
                  <div className="rounded-[var(--control-radius)] bg-foreground/[0.025] px-3 py-2">
                    <div className="text-muted-foreground/60">Status</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderDraft.enabled ? "Enabled" : "Off"}
                    </div>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground/65">
                  This adds a draft account. Use Save on the Providers page to keep it.
                </p>
              </div>
            ) : null}
          </DialogPanel>

          <DialogFooter className="bg-muted/18 px-4 py-3 sm:px-5">
            <Button type="button" variant="ghost" onClick={closeAddProviderDialog}>
              Cancel
            </Button>
            {addProviderStep !== "provider" ? (
              <Button type="button" variant="outline" onClick={goToPreviousAddProviderStep}>
                Back
              </Button>
            ) : null}
            {addProviderStep === "review" ? (
              <Button
                type="button"
                onClick={() => addProviderInstance(addProviderDraft)}
                disabled={!canCreateProviderDraft}
                data-provider-settings-add-provider-create="true"
              >
                Create draft
              </Button>
            ) : (
              <Button type="button" onClick={goToNextAddProviderStep}>
                Next
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function ProviderSettingsSection(
  props: Parameters<typeof useProviderSettingsSectionComponent>[0],
) {
  return useProviderSettingsSectionComponent(props);
}
