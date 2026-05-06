import {
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderRuntime,
} from "@ace/contracts";
import { type UnifiedSettings, DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { formatProviderModelDisplayName, normalizeModelSlug } from "@ace/shared/model";
import { resolveProviderSettings } from "@ace/shared/providerInstances";

import { cn } from "../../lib/utils";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import {
  PROVIDER_INSTANCE_BADGE_COLORS,
  PROVIDER_INSTANCE_BADGE_ICONS,
  ProviderInstanceBadge,
  ProviderInstanceBadgeIconGlyph,
  normalizeProviderInstanceBadgeColor,
  normalizeProviderInstanceBadgeIcon,
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
  SettingsSection,
  SettingResetButton,
} from "./SettingsPanelPrimitives";

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

const ADD_PROVIDER_STEPS: ReadonlyArray<{
  id: AddProviderStep;
  label: string;
}> = [
  { id: "provider", label: "Provider" },
  { id: "setup", label: "Setup" },
  { id: "review", label: "Review" },
];

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
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(separatorIndex + 1);
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

export function ProviderSettingsSection({
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
  const [draftProviders, setDraftProviders] = useState(() => settings.providers);
  const [selectedEntryKey, setSelectedEntryKey] = useState(() =>
    providerEntryKey(providerCards[0]?.provider ?? "codex"),
  );
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [addProviderStep, setAddProviderStep] = useState<AddProviderStep>("provider");
  const [addProviderDraft, setAddProviderDraft] = useState(() =>
    createAddProviderDraft(providerCards[0]?.provider ?? "codex", settings.providers),
  );
  useEffect(() => {
    setDraftProviders(settings.providers);
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
      setSelectedEntryKey(firstEntry.key);
    }
  }, [providerEntries, selectedEntryKey]);

  const hasProviderDraftChanges =
    allProviderSettingsFingerprint(draftProviders) !==
    allProviderSettingsFingerprint(settings.providers);

  const updateProviderConfig = <TProvider extends ProviderKind>(
    provider: TProvider,
    config: UnifiedSettings["providers"][TProvider],
  ) => {
    setDraftProviders((existing) => ({
      ...existing,
      [provider]: config,
    }));
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
    setDraftProviders(settings.providers);
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
    setSelectedEntryKey(providerEntryKey(provider, instanceId));
    setAddProviderOpen(false);
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
  };

  const addDraftCustomModel = (providerCard: ProviderCard, providerInstanceId?: string) => {
    const provider = providerCard.provider;
    const customModelInput = customModelInputByProvider[provider];
    const providerConfig = draftProviders[provider];
    const providerInstance = providerInstanceId
      ? providerConfig.instances.find((instance) => instance.id === providerInstanceId)
      : undefined;
    const customModels = providerInstance?.customModels ?? providerConfig.customModels;
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
    if (customModels.includes(normalized)) {
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
  const isUpgrading = isUpgradingProvider(providerCard.provider);
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
  const displayedModels = baseModels.filter(
    (model) => !model.isCustom || selectedCustomModels.includes(model.slug),
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
    setAddProviderDraft(createAddProviderDraft(provider, draftProviders));
    setAddProviderStep("provider");
  };
  const openAddProviderDialog = () => {
    resetAddProviderDialog(selectedProviderEntry.provider);
    setAddProviderOpen(true);
  };
  const closeAddProviderDialog = () => {
    setAddProviderOpen(false);
  };
  const selectAddProvider = (provider: ProviderKind) => {
    setAddProviderDraft(createAddProviderDraft(provider, draftProviders));
  };
  const goToPreviousAddProviderStep = () => {
    const previousStep = ADD_PROVIDER_STEPS[Math.max(0, addProviderCurrentStepIndex - 1)];
    if (previousStep) {
      setAddProviderStep(previousStep.id);
    }
  };
  const goToNextAddProviderStep = () => {
    const nextStep =
      ADD_PROVIDER_STEPS[Math.min(ADD_PROVIDER_STEPS.length - 1, addProviderCurrentStepIndex + 1)];
    if (nextStep) {
      setAddProviderStep(nextStep.id);
    }
  };

  return (
    <SettingsSection
      title="Providers"
      description="Configure provider CLIs, accounts, launch paths, and custom models."
      contentClassName="overflow-visible border-pill-border/58 bg-pill/58 p-0 supports-[backdrop-filter]:bg-pill/48 supports-[backdrop-filter]:backdrop-blur-lg"
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
          {hasProviderDraftChanges ? (
            <span className="rounded-full border border-warning/35 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground">
              Unsaved
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-[var(--control-radius)] text-muted-foreground/70 hover:text-foreground disabled:text-muted-foreground/35"
                  disabled={!hasProviderDraftChanges}
                  onClick={revertProviderDraft}
                  aria-label="Revert provider changes"
                >
                  <Undo2Icon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Revert provider changes</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "size-7 rounded-[var(--control-radius)] text-muted-foreground/70 hover:text-foreground disabled:text-muted-foreground/35",
                    hasProviderDraftChanges && "text-foreground",
                  )}
                  disabled={!hasProviderDraftChanges}
                  onClick={saveProviderDraft}
                  aria-label="Save provider changes"
                >
                  <SaveIcon className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup side="top">Save provider changes</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-[var(--control-radius)] text-muted-foreground/70 hover:text-foreground disabled:text-muted-foreground/35"
                  disabled={isRefreshingProviders}
                  onClick={() => void refreshProviders()}
                  aria-label="Refresh provider status"
                >
                  {isRefreshingProviders ? (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh provider status</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      <div className="grid min-h-[34rem] overflow-hidden rounded-[var(--panel-radius)] border border-border/45 bg-background/20 md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <div className="border-b border-border/45 bg-background/25 p-2 md:border-r md:border-b-0">
          <Button
            size="sm"
            variant="outline"
            className="mb-2 h-8 w-full rounded-[var(--control-radius)] justify-start gap-1.5 px-2 text-xs"
            onClick={openAddProviderDialog}
            aria-label="Add provider instance"
            data-provider-settings-add-provider="true"
          >
            <PlusIcon className="size-3" />
            Add provider
          </Button>

          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-1">
            {providerEntries.map((entry) => {
              const railProviderCard =
                providerCards.find((candidate) => candidate.provider === entry.provider) ??
                providerCards[0];
              if (!railProviderCard) return null;
              const RailLogo = PROVIDER_LOGO_BY_PROVIDER[entry.provider];
              const isSelected = entry.key === selectedProviderEntry.key;
              const railSubtitle = entry.accountLabel ?? "Default";
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={cn(
                    "group flex min-w-0 items-center gap-2 rounded-[var(--control-radius)] border px-2 py-2 text-left transition-colors",
                    isSelected
                      ? "border-border/60 bg-foreground/[0.06] text-foreground"
                      : "border-transparent bg-transparent text-muted-foreground hover:border-border/45 hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                  onClick={() => setSelectedEntryKey(entry.key)}
                >
                  <span
                    className={cn(
                      "relative flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] border transition-colors",
                      isSelected
                        ? "border-border/55 bg-background text-foreground"
                        : "border-border/35 bg-background/45 text-muted-foreground group-hover:text-foreground",
                    )}
                  >
                    <RailLogo className="size-3.5" />
                    {entry.instanceId ? (
                      <ProviderInstanceBadge
                        color={entry.badgeColor}
                        icon={entry.badgeIcon}
                        className="absolute -bottom-1 -right-1 size-3.5 border-[1.5px] p-[2px]"
                      />
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      entry.enabled ? railProviderCard.statusStyle.dot : "bg-muted-foreground/35",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block min-w-0 truncate text-xs font-medium">
                      {getProviderCardDisplayName(railProviderCard)}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/55">
                      {entry.enabled ? railSubtitle : `${railSubtitle} · Off`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0">
          <div className="border-b border-border/45 bg-background/25 px-3 py-3 sm:px-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-background/60">
                  <ProviderLogo className="size-5 text-foreground" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-[14px] font-semibold tracking-tight text-foreground">
                      {providerDisplayName}
                    </h3>
                    {selectedProviderEntry.accountLabel ? (
                      <span className="rounded-full border border-border/45 bg-background/55 px-2 py-0.5 text-[11px] text-muted-foreground">
                        {selectedProviderEntry.accountLabel}
                      </span>
                    ) : null}
                    {providerCard.versionLabel ? (
                      <code className="rounded border border-border/40 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {providerCard.versionLabel}
                      </code>
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
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground/70">
                    <span className="inline-flex items-center gap-1">
                      <span className={cn("size-1.5 rounded-full", providerCard.statusStyle.dot)} />
                      {providerCard.summary.headline}
                    </span>
                    {providerCard.summary.detail ? (
                      <span>{providerCard.summary.detail}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2 md:justify-end">
                {selectedInstance ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 rounded-[var(--control-radius)] text-muted-foreground/60 hover:text-foreground"
                    onClick={() => {
                      removeProviderInstance(providerCard, selectedInstance.id);
                      setSelectedEntryKey(providerEntryKey(providerCard.provider));
                    }}
                    aria-label={`Remove ${selectedInstance.label}`}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
                {providerCard.canUpgradeCli ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                    disabled={isUpgrading}
                    onClick={() => upgradeProviderCli(providerCard.provider, providerCard.provider)}
                  >
                    {isUpgrading ? (
                      <LoaderIcon className="size-3 animate-spin" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                    {isUpgrading ? "Upgrading" : "Upgrade CLI"}
                  </Button>
                ) : null}
                <Switch
                  checked={selectedInstance?.enabled ?? draftConfig.enabled}
                  onCheckedChange={(checked) => {
                    updateSelectedEntryConfig({ enabled: Boolean(checked) });
                  }}
                  aria-label={`Enable ${selectedProviderEntry.title}`}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 p-3">
            {selectedInstance ? (
              <section className="rounded-[var(--control-radius)] border border-border/45 bg-background/45">
                <div className="border-b border-border/35 px-3 py-2">
                  <div className="text-xs font-semibold text-foreground/90">Identity</div>
                </div>
                <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">Name</span>
                    <Input
                      className="mt-1"
                      value={selectedInstance.label}
                      onChange={(event) =>
                        updateProviderInstance(providerCard, selectedInstance.id, {
                          label: event.target.value,
                        })
                      }
                      placeholder="Personal"
                    />
                  </label>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-medium text-foreground/75">Icon</div>
                      <div className="flex flex-wrap items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
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
                                      "flex size-6 items-center justify-center rounded-[calc(var(--control-radius)-3px)] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
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
                      <div className="mb-1 text-[11px] font-medium text-foreground/75">Color</div>
                      <div className="flex flex-wrap items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
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
                                      "flex size-6 items-center justify-center rounded-full border border-transparent transition-colors hover:border-border/70",
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
              </section>
            ) : null}

            <section className="rounded-[var(--control-radius)] border border-border/45 bg-background/45">
              <div className="border-b border-border/35 px-3 py-2">
                <div className="text-xs font-semibold text-foreground/90">Launch</div>
              </div>
              <div className="grid gap-3 p-3 md:grid-cols-2">
                <label className="block">
                  <span className="text-[11px] font-medium text-foreground/75">Binary path</span>
                  <Input
                    id={`provider-install-${providerCard.provider}-binary-path`}
                    className="mt-1"
                    value={String(selectedEntryConfig.binaryPath ?? "")}
                    onChange={(event) =>
                      updateSelectedEntryConfig({
                        binaryPath: event.target.value,
                      })
                    }
                    placeholder={providerCard.binaryPlaceholder}
                    spellCheck={false}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground/55">
                    {providerCard.binaryDescription}
                  </span>
                </label>

                {providerCard.provider === "githubCopilot" ? (
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">
                      CLI server URL
                    </span>
                    <Input
                      className="mt-1"
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
                      <span className="mt-1 block text-[11px] text-muted-foreground/55">
                        {providerCard.cliUrlDescription}
                      </span>
                    ) : null}
                  </label>
                ) : null}

                {selectedPathLabel ? (
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">
                      {selectedPathLabel}
                    </span>
                    <Input
                      className="mt-1"
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
                      <span className="mt-1 block text-[11px] text-muted-foreground/55">
                        {providerCard.homeDescription}
                      </span>
                    ) : null}
                  </label>
                ) : null}

                <label className="block md:col-span-2">
                  <span className="text-[11px] font-medium text-foreground/75">Launch env</span>
                  <Textarea
                    className="mt-1"
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
                </label>
              </div>

              {providerCard.runtimes && providerCard.runtimes.length > 0 ? (
                <div className="border-t border-border/35 px-3 py-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">
                    Runtimes
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {providerCard.runtimes.map((runtime) => {
                      const upgradingRuntime = isUpgradingRuntime(
                        providerCard.provider,
                        runtime.id,
                      );
                      return (
                        <div
                          key={`${providerCard.provider}:${runtime.id}`}
                          className="flex items-center justify-between gap-3 rounded-[var(--control-radius)] border border-border/35 bg-muted/20 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground/90">
                                {runtime.label}
                              </span>
                              {runtime.version ? (
                                <code className="text-[11px] text-muted-foreground/60">
                                  {runtime.version}
                                </code>
                              ) : null}
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground/60">
                              {runtime.binaryPath}
                            </div>
                          </div>
                          {runtime.upgradeable ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                              disabled={upgradingRuntime}
                              onClick={() => upgradeProviderCli(providerCard.provider, runtime.id)}
                            >
                              {upgradingRuntime ? (
                                <LoaderIcon className="size-3 animate-spin" />
                              ) : (
                                <RefreshCwIcon className="size-3" />
                              )}
                              Upgrade
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="rounded-[var(--control-radius)] border border-border/45 bg-background/45">
              <div className="flex items-center justify-between gap-3 border-b border-border/35 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold text-foreground/90">Models</div>
                  <div className="text-[11px] text-muted-foreground/55">
                    {displayedModels.length} available, {selectedCustomModels.length} custom.
                  </div>
                </div>
              </div>
              <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div
                  ref={(element) => {
                    modelListRefs.current[providerCard.provider] = element;
                  }}
                  className="max-h-56 overflow-y-auto rounded-[var(--control-radius)] border border-border/35 bg-muted/10"
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
                        className="flex min-h-9 items-center gap-2 border-t border-border/25 px-3 py-1.5 first:border-t-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                          {model.name}
                        </span>
                        {capLabels.map((label) => (
                          <span
                            key={label}
                            className="hidden rounded-full border border-border/35 px-1.5 py-0.5 text-[10px] text-muted-foreground/65 sm:inline-flex"
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
                                  className="shrink-0 text-muted-foreground/35 transition-colors duration-150 hover:text-muted-foreground/60"
                                  aria-label={`Details for ${model.name}`}
                                >
                                  <InfoIcon className="size-3" />
                                </button>
                              }
                            />
                            <TooltipPopup side="top" className="max-w-56">
                              <code className="block text-[11px] text-foreground">
                                {model.slug}
                              </code>
                            </TooltipPopup>
                          </Tooltip>
                        ) : null}
                        {model.isCustom ? (
                          <button
                            type="button"
                            className="rounded-full border border-border/35 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
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
                </div>

                <div className="rounded-[var(--control-radius)] border border-border/35 bg-muted/10 p-3">
                  <div className="text-xs font-medium text-foreground/85">Add custom model</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground/55">
                    Custom model slugs are saved with this provider after Save.
                  </div>
                  <Input
                    id={`custom-model-${providerCard.provider}`}
                    className="mt-3"
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
                    className="mt-2 h-8 w-full rounded-[var(--control-radius)] gap-1.5 text-xs"
                    variant="outline"
                    onClick={() =>
                      addDraftCustomModel(providerCard, selectedProviderEntry.instanceId)
                    }
                  >
                    <PlusIcon className="size-3.5" />
                    Add model
                  </Button>
                  {customModelError ? (
                    <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
      <Dialog
        onOpenChange={(open) => {
          setAddProviderOpen(open);
          if (!open) {
            setAddProviderStep("provider");
          }
        }}
        open={addProviderOpen}
      >
        <DialogPopup className="max-w-2xl" data-provider-settings-add-provider-modal="true">
          <DialogHeader className="gap-2 border-b border-border/45 px-4 py-3 sm:px-5 sm:py-4">
            <div className="flex items-center gap-2">
              <span className="relative flex size-8 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-background/55">
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
            <div className="grid grid-cols-3 gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/45 p-1">
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
                        setAddProviderStep(step.id);
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
              <div className="grid gap-2 sm:grid-cols-2" data-provider-setup-step="provider">
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
                        "flex min-w-0 items-center gap-3 rounded-[var(--control-radius)] border px-3 py-2.5 text-left transition-colors",
                        isSelected
                          ? "border-primary/55 bg-primary/10 text-foreground"
                          : "border-border/40 bg-background/40 text-muted-foreground hover:border-border/70 hover:bg-foreground/[0.04] hover:text-foreground",
                      )}
                      onClick={() => selectAddProvider(candidate.provider)}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-background/60">
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
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">Name</span>
                    <Input
                      className="mt-1"
                      value={addProviderDraft.label}
                      onChange={(event) =>
                        setAddProviderDraft((draft) => ({
                          ...draft,
                          label: event.target.value,
                        }))
                      }
                      placeholder="Personal"
                      autoFocus
                    />
                  </label>
                  <label className="flex items-end justify-between gap-3 rounded-[var(--control-radius)] border border-border/35 bg-background/45 px-3 py-2">
                    <span className="text-xs font-medium text-foreground/80">Enabled</span>
                    <Switch
                      checked={addProviderDraft.enabled}
                      onCheckedChange={(checked) =>
                        setAddProviderDraft((draft) => ({
                          ...draft,
                          enabled: Boolean(checked),
                        }))
                      }
                      aria-label="Enable new provider account"
                    />
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-foreground/75">Badge</div>
                    <div className="flex flex-wrap items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
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
                                    setAddProviderDraft((draft) => ({
                                      ...draft,
                                      badgeIcon: badgeIcon.value,
                                    }))
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
                    <div className="flex flex-wrap items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
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
                                    setAddProviderDraft((draft) => ({
                                      ...draft,
                                      badgeColor: badgeColor.value,
                                    }))
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

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">Binary path</span>
                    <Input
                      className="mt-1"
                      value={addProviderDraft.binaryPath}
                      onChange={(event) =>
                        setAddProviderDraft((draft) => ({
                          ...draft,
                          binaryPath: event.target.value,
                        }))
                      }
                      placeholder={addProviderCard?.binaryPlaceholder}
                      spellCheck={false}
                    />
                  </label>

                  {addProviderPathLabel ? (
                    <label className="block">
                      <span className="text-[11px] font-medium text-foreground/75">
                        {addProviderPathLabel}
                      </span>
                      <Input
                        className="mt-1"
                        value={addProviderDraft.pathValue}
                        onChange={(event) =>
                          setAddProviderDraft((draft) => ({
                            ...draft,
                            pathValue: event.target.value,
                          }))
                        }
                        placeholder={addProviderCard?.homePlaceholder}
                        spellCheck={false}
                      />
                    </label>
                  ) : null}

                  {addProviderDraft.provider === "githubCopilot" ? (
                    <label className="block">
                      <span className="text-[11px] font-medium text-foreground/75">
                        CLI server URL
                      </span>
                      <Input
                        className="mt-1"
                        value={addProviderDraft.cliUrl}
                        onChange={(event) =>
                          setAddProviderDraft((draft) => ({
                            ...draft,
                            cliUrl: event.target.value,
                          }))
                        }
                        placeholder={addProviderCard?.cliUrlPlaceholder}
                        spellCheck={false}
                      />
                    </label>
                  ) : null}
                </div>

                <label className="block">
                  <span className="text-[11px] font-medium text-foreground/75">Launch env</span>
                  <Textarea
                    className="mt-1"
                    size="sm"
                    value={addProviderDraft.launchEnvText}
                    onChange={(event) =>
                      setAddProviderDraft((draft) => ({
                        ...draft,
                        launchEnvText: event.target.value,
                      }))
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
                <div className="flex items-center gap-3 rounded-[var(--control-radius)] border border-border/45 bg-background/45 px-3 py-3">
                  <span className="relative flex size-10 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/45 bg-background/60">
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

                <div className="grid overflow-hidden rounded-[var(--control-radius)] border border-border/40 bg-background/35 text-xs sm:grid-cols-2">
                  <div className="border-b border-border/30 px-3 py-2 sm:border-r sm:border-b-0">
                    <div className="text-muted-foreground/60">Binary</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderDraft.binaryPath.trim() || addProviderCard?.binaryPlaceholder}
                    </div>
                  </div>
                  <div className="border-b border-border/30 px-3 py-2 sm:border-b-0">
                    <div className="text-muted-foreground/60">State path</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderPathLabel
                        ? addProviderDraft.pathValue.trim() || "Default"
                        : "Provider default"}
                    </div>
                  </div>
                  <div className="border-b border-border/30 px-3 py-2 sm:border-r sm:border-b-0">
                    <div className="text-muted-foreground/60">Env</div>
                    <div className="mt-0.5 truncate text-foreground/90">
                      {addProviderLaunchEnvCount === 0
                        ? "None"
                        : `${addProviderLaunchEnvCount} variable${
                            addProviderLaunchEnvCount === 1 ? "" : "s"
                          }`}
                    </div>
                  </div>
                  <div className="px-3 py-2">
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

          <DialogFooter className="border-t border-border/45 bg-muted/18 px-4 py-3 sm:px-5">
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
    </SettingsSection>
  );
}
