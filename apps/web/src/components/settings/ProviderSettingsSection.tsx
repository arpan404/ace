import {
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderModel,
  type ServerProviderRuntime,
} from "@ace/contracts";
import { type UnifiedSettings, DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";
import { formatProviderModelDisplayName, normalizeModelSlug } from "@ace/shared/model";

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
  runtimes?: ReadonlyArray<ServerProviderRuntime> | undefined;
  statusStyle: ProviderStatusStyle;
  summary: ProviderSummary;
  versionLabel: string | null;
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
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind>(
    () => providerCards[0]?.provider ?? "codex",
  );
  useEffect(() => {
    setDraftProviders(settings.providers);
  }, [settings.providers]);
  useEffect(() => {
    if (providerCards.some((providerCard) => providerCard.provider === selectedProvider)) {
      return;
    }
    const firstProvider = providerCards[0]?.provider;
    if (firstProvider) {
      setSelectedProvider(firstProvider);
    }
  }, [providerCards, selectedProvider]);

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
    updateSettings({
      providers: draftProviders,
      ...(!draftProviders[textGenProvider].enabled
        ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
        : {}),
    });
  };

  const revertProviderDraft = () => {
    setDraftProviders(settings.providers);
  };

  const addProviderInstance = (providerCard: ProviderCard) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    const instanceId = `${provider}-${Date.now().toString(36)}`;
    const base = {
      id: instanceId,
      label: `Account ${providerConfig.instances.length + 1}`,
      enabled: true,
      badgeColor: "slate",
      badgeIcon: "circle",
      binaryPath: providerConfig.binaryPath,
      customModels: [],
      launchEnv: {},
    };
    const nextInstance =
      provider === "codex"
        ? { ...base, homePath: "" }
        : provider === "githubCopilot"
          ? { ...base, homePath: "", cliUrl: "" }
          : provider === "claudeAgent" || provider === "cursor" || provider === "opencode"
            ? { ...base, configDir: "" }
            : provider === "pi"
              ? { ...base, agentDir: "" }
              : base;

    updateProviderConfig(provider, {
      ...providerConfig,
      instances: [...providerConfig.instances, nextInstance],
    } as UnifiedSettings["providers"][typeof provider]);
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

  const addDraftCustomModel = (providerCard: ProviderCard) => {
    const provider = providerCard.provider;
    const customModelInput = customModelInputByProvider[provider];
    const providerConfig = draftProviders[provider];
    const customModels = providerConfig.customModels;
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

    updateProviderConfig(provider, {
      ...providerConfig,
      customModels: [...customModels, normalized],
    } as UnifiedSettings["providers"][typeof provider]);
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

  const removeDraftCustomModel = (providerCard: ProviderCard, slug: string) => {
    const provider = providerCard.provider;
    const providerConfig = draftProviders[provider];
    updateProviderConfig(provider, {
      ...providerConfig,
      customModels: providerConfig.customModels.filter((model) => model !== slug),
    } as UnifiedSettings["providers"][typeof provider]);
    setCustomModelErrorByProvider((existing) => ({
      ...existing,
      [provider]: null,
    }));
  };

  const selectedProviderCard =
    providerCards.find((providerCard) => providerCard.provider === selectedProvider) ??
    providerCards[0];

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
  const customModelInput = customModelInputByProvider[providerCard.provider];
  const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
  const providerDisplayName = PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;
  const ProviderLogo = PROVIDER_LOGO_BY_PROVIDER[providerCard.provider];
  const isUpgrading = isUpgradingProvider(providerCard.provider);
  const draftConfig = draftProviders[providerCard.provider];
  const defaultProviderConfig = DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider];
  const isDraftDefaultDirty =
    providerSettingsFingerprint(draftConfig) !== providerSettingsFingerprint(defaultProviderConfig);
  const displayedModels = providerCard.models.filter(
    (model) => !model.isCustom || draftConfig.customModels.includes(model.slug),
  );
  for (const slug of draftConfig.customModels) {
    if (displayedModels.some((model) => model.slug === slug)) continue;
    displayedModels.push({
      slug,
      name: formatProviderModelDisplayName(providerCard.provider, slug),
      isCustom: true,
      capabilities: null,
    });
  }

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
      <div className="grid min-h-[34rem] overflow-hidden rounded-[var(--panel-radius)] border border-border/45 bg-background/20 md:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="border-b border-border/45 bg-background/25 p-2 md:border-r md:border-b-0">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-1">
            {providerCards.map((railProviderCard) => {
              const RailLogo = PROVIDER_LOGO_BY_PROVIDER[railProviderCard.provider];
              const railConfig = draftProviders[railProviderCard.provider];
              const isSelected = railProviderCard.provider === providerCard.provider;
              const railDisplayName =
                PROVIDER_DISPLAY_NAMES[railProviderCard.provider] ?? railProviderCard.title;
              const railInstanceCount = railConfig.instances.length;
              return (
                <button
                  key={railProviderCard.provider}
                  type="button"
                  className={cn(
                    "group flex min-w-0 items-center gap-2 rounded-[var(--control-radius)] border px-2 py-2 text-left transition-colors",
                    isSelected
                      ? "border-border/60 bg-foreground/[0.06] text-foreground"
                      : "border-transparent bg-transparent text-muted-foreground hover:border-border/45 hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                  onClick={() => setSelectedProvider(railProviderCard.provider)}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] border transition-colors",
                      isSelected
                        ? "border-border/55 bg-background text-foreground"
                        : "border-border/35 bg-background/45 text-muted-foreground group-hover:text-foreground",
                    )}
                  >
                    <RailLogo className="size-3.5" />
                  </span>
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      railProviderCard.statusStyle.dot,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block min-w-0 truncate text-xs font-medium">
                      {railDisplayName}
                    </span>
                    {railInstanceCount > 0 || !railConfig.enabled ? (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/55">
                        {railInstanceCount > 0
                          ? `${railInstanceCount} ${railInstanceCount === 1 ? "account" : "accounts"}`
                          : "Off"}
                      </span>
                    ) : null}
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
                  checked={draftConfig.enabled}
                  onCheckedChange={(checked) => {
                    updateProviderConfig(providerCard.provider, {
                      ...draftConfig,
                      enabled: Boolean(checked),
                    } as UnifiedSettings["providers"][typeof providerCard.provider]);
                  }}
                  aria-label={`Enable ${providerDisplayName}`}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 p-3">
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
                    value={draftConfig.binaryPath}
                    onChange={(event) =>
                      updateProviderConfig(providerCard.provider, {
                        ...draftConfig,
                        binaryPath: event.target.value,
                      } as UnifiedSettings["providers"][typeof providerCard.provider])
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
                      value={"cliUrl" in draftConfig ? draftConfig.cliUrl : ""}
                      onChange={(event) =>
                        updateProviderConfig("githubCopilot", {
                          ...draftProviders.githubCopilot,
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

                {providerCard.homePathKey ? (
                  <label className="block">
                    <span className="text-[11px] font-medium text-foreground/75">
                      CODEX_HOME path
                    </span>
                    <Input
                      className="mt-1"
                      value={"homePath" in draftConfig ? draftConfig.homePath : ""}
                      onChange={(event) =>
                        updateProviderConfig("codex", {
                          ...draftProviders.codex,
                          homePath: event.target.value,
                        })
                      }
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
                  <div className="text-xs font-semibold text-foreground/90">Accounts</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                  onClick={() => addProviderInstance(providerCard)}
                >
                  <PlusIcon className="size-3" />
                  Add
                </Button>
              </div>

              {draftConfig.instances.length > 0 ? (
                <div className="divide-y divide-border/35">
                  {draftConfig.instances.map((instance) => {
                    const pathLabel = instancePathLabel(providerCard.provider);
                    const normalizedBadgeColor = normalizeProviderInstanceBadgeColor(
                      instance.badgeColor,
                    );
                    const normalizedBadgeIcon = normalizeProviderInstanceBadgeIcon(
                      instance.badgeIcon,
                    );
                    const launchEnvCount = Object.keys(instance.launchEnv).length;
                    const pathValue =
                      "homePath" in instance
                        ? instance.homePath
                        : "configDir" in instance
                          ? instance.configDir
                          : "agentDir" in instance
                            ? instance.agentDir
                            : "";
                    return (
                      <div key={`${providerCard.provider}:${instance.id}`} className="p-3">
                        <div className="rounded-[var(--control-radius)] border border-border/35 bg-background/35 p-3">
                          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <ProviderInstanceBadge
                                color={instance.badgeColor}
                                icon={instance.badgeIcon}
                                className="size-5 shrink-0"
                              />
                              <Input
                                className="h-8 min-w-0 max-w-56 border-input/60 bg-background/70 text-sm font-medium"
                                value={instance.label}
                                onChange={(event) =>
                                  updateProviderInstance(providerCard, instance.id, {
                                    label: event.target.value,
                                  })
                                }
                                placeholder="Account name"
                              />
                              <Switch
                                checked={instance.enabled}
                                onCheckedChange={(checked) =>
                                  updateProviderInstance(providerCard, instance.id, {
                                    enabled: Boolean(checked),
                                  })
                                }
                                aria-label={`Enable ${instance.label}`}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-7 rounded-[var(--control-radius)] text-muted-foreground/55 hover:text-foreground"
                                onClick={() => removeProviderInstance(providerCard, instance.id)}
                                aria-label={`Remove ${instance.label}`}
                              >
                                <XIcon className="size-3.5" />
                              </Button>
                            </div>

                            <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
                              <div className="flex items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
                                {PROVIDER_INSTANCE_BADGE_ICONS.map((badgeIcon) => (
                                  <Tooltip key={badgeIcon.value}>
                                    <TooltipTrigger
                                      render={
                                        <button
                                          type="button"
                                          className={cn(
                                            "flex size-6 items-center justify-center rounded-[calc(var(--control-radius)-3px)] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
                                            normalizedBadgeIcon === badgeIcon.value &&
                                              "bg-foreground/[0.08] text-foreground",
                                          )}
                                          onClick={() =>
                                            updateProviderInstance(providerCard, instance.id, {
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
                                ))}
                              </div>

                              <div className="flex items-center gap-1 rounded-[var(--control-radius)] border border-border/35 bg-background/40 p-1">
                                {PROVIDER_INSTANCE_BADGE_COLORS.map((badgeColor) => (
                                  <Tooltip key={badgeColor.value}>
                                    <TooltipTrigger
                                      render={
                                        <button
                                          type="button"
                                          className={cn(
                                            "flex size-6 items-center justify-center rounded-full border border-transparent transition-colors hover:border-border/70",
                                            normalizedBadgeColor === badgeColor.value &&
                                              "border-foreground/75",
                                          )}
                                          onClick={() =>
                                            updateProviderInstance(providerCard, instance.id, {
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
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                            <label className="block">
                              <span className="text-[11px] font-medium text-foreground/75">
                                Binary path
                              </span>
                              <Input
                                className="mt-1"
                                value={instance.binaryPath}
                                onChange={(event) =>
                                  updateProviderInstance(providerCard, instance.id, {
                                    binaryPath: event.target.value,
                                  })
                                }
                                placeholder={providerCard.binaryPlaceholder}
                                spellCheck={false}
                              />
                            </label>
                            {pathLabel ? (
                              <label className="block">
                                <span className="text-[11px] font-medium text-foreground/75">
                                  {pathLabel}
                                </span>
                                <Input
                                  className="mt-1"
                                  value={pathValue}
                                  onChange={(event) => {
                                    const pathKey =
                                      providerCard.provider === "codex" ||
                                      providerCard.provider === "githubCopilot"
                                        ? "homePath"
                                        : providerCard.provider === "pi"
                                          ? "agentDir"
                                          : "configDir";
                                    updateProviderInstance(providerCard, instance.id, {
                                      [pathKey]: event.target.value,
                                    });
                                  }}
                                  spellCheck={false}
                                />
                              </label>
                            ) : null}
                            {providerCard.provider === "githubCopilot" && "cliUrl" in instance ? (
                              <label className="block md:col-span-2">
                                <span className="text-[11px] font-medium text-foreground/75">
                                  CLI server URL
                                </span>
                                <Input
                                  className="mt-1"
                                  value={instance.cliUrl}
                                  onChange={(event) =>
                                    updateProviderInstance(providerCard, instance.id, {
                                      cliUrl: event.target.value,
                                    })
                                  }
                                  placeholder={providerCard.cliUrlPlaceholder}
                                  spellCheck={false}
                                />
                              </label>
                            ) : null}
                            <details className="md:col-span-2 rounded-[var(--control-radius)] border border-border/35 bg-background/35">
                              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[11px] font-medium text-foreground/75 marker:hidden">
                                <span>Env</span>
                                <span className="text-[10px] font-normal text-muted-foreground/55">
                                  {launchEnvCount === 0
                                    ? "None"
                                    : `${launchEnvCount} ${launchEnvCount === 1 ? "var" : "vars"}`}
                                </span>
                              </summary>
                              <div className="border-t border-border/35 p-2">
                                <Textarea
                                  size="sm"
                                  value={formatLaunchEnv(instance.launchEnv)}
                                  onChange={(event) =>
                                    updateProviderInstance(providerCard, instance.id, {
                                      launchEnv: parseLaunchEnv(event.target.value),
                                    })
                                  }
                                  placeholder={
                                    providerCard.provider === "gemini"
                                      ? "GEMINI_API_KEY=..."
                                      : "KEY=value"
                                  }
                                  spellCheck={false}
                                />
                              </div>
                            </details>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-6">
                  <div className="rounded-[var(--control-radius)] border border-dashed border-border/55 bg-background/30 px-4 py-6 text-center">
                    <div className="text-sm font-medium text-foreground/85">No accounts</div>
                    <div className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground/60">
                      Add one for separate credentials, config paths, or a composer badge.
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 h-8 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                      onClick={() => addProviderInstance(providerCard)}
                    >
                      <PlusIcon className="size-3" />
                      Add
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-[var(--control-radius)] border border-border/45 bg-background/45">
              <div className="flex items-center justify-between gap-3 border-b border-border/35 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold text-foreground/90">Models</div>
                  <div className="text-[11px] text-muted-foreground/55">
                    {displayedModels.length} available, {draftConfig.customModels.length} custom.
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
                            onClick={() => removeDraftCustomModel(providerCard, model.slug)}
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
                      addDraftCustomModel(providerCard);
                    }}
                    placeholder={resolveCustomModelPlaceholder(providerCard.provider)}
                    spellCheck={false}
                  />
                  <Button
                    className="mt-2 h-8 w-full rounded-[var(--control-radius)] gap-1.5 text-xs"
                    variant="outline"
                    onClick={() => addDraftCustomModel(providerCard)}
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
    </SettingsSection>
  );
}
