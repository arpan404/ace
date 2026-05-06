import {
  ChevronDownIcon,
  InfoIcon,
  LoaderIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import type { Dispatch, MutableRefObject, ReactNode, SetStateAction } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderModel,
  type ServerProviderRuntime,
} from "@ace/contracts";
import { type UnifiedSettings, DEFAULT_UNIFIED_SETTINGS } from "@ace/contracts/settings";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  binaryPathValue: string;
  cliUrlValue?: string | undefined;
  isDirty: boolean;
  models: ReadonlyArray<ServerProviderModel>;
  providerConfig: UnifiedSettings["providers"][ProviderKind];
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

export function ProviderSettingsSection({
  addCustomModel,
  codexHomePath,
  customModelErrorByProvider,
  customModelInputByProvider,
  isRefreshingProviders,
  isUpgradingProvider,
  isUpgradingRuntime,
  lastCheckedAt,
  modelListRefs,
  openProviderDetails,
  providerCards,
  refreshProviders,
  removeCustomModel,
  setCustomModelErrorByProvider,
  setCustomModelInputByProvider,
  setOpenProviderDetails,
  settings,
  textGenProvider,
  upgradeProviderCli,
  updateSettings,
}: {
  addCustomModel: (provider: ProviderKind) => void;
  codexHomePath: string;
  customModelErrorByProvider: Partial<Record<ProviderKind, string | null>>;
  customModelInputByProvider: Record<ProviderKind, string>;
  isRefreshingProviders: boolean;
  isUpgradingProvider: (provider: ProviderKind) => boolean;
  isUpgradingRuntime: (provider: ProviderKind, runtimeId: string) => boolean;
  lastCheckedAt: string | null;
  modelListRefs: MutableRefObject<Partial<Record<ProviderKind, HTMLDivElement | null>>>;
  openProviderDetails: Record<ProviderKind, boolean>;
  providerCards: ReadonlyArray<ProviderCard>;
  refreshProviders: () => void;
  removeCustomModel: (provider: ProviderKind, slug: string) => void;
  setCustomModelErrorByProvider: Dispatch<
    SetStateAction<Partial<Record<ProviderKind, string | null>>>
  >;
  setCustomModelInputByProvider: Dispatch<SetStateAction<Record<ProviderKind, string>>>;
  setOpenProviderDetails: Dispatch<SetStateAction<Record<ProviderKind, boolean>>>;
  settings: UnifiedSettings;
  textGenProvider: ProviderKind;
  upgradeProviderCli: (provider: ProviderKind, runtimeId: string) => void;
  updateSettings: (patch: Partial<UnifiedSettings>) => void;
}) {
  const updateProviderConfig = <TProvider extends ProviderKind>(
    provider: TProvider,
    config: UnifiedSettings["providers"][TProvider],
  ) => {
    updateSettings({
      providers: {
        ...settings.providers,
        [provider]: config,
      },
    });
  };

  const addProviderInstance = (providerCard: ProviderCard) => {
    const provider = providerCard.provider;
    const providerConfig = settings.providers[provider];
    const instanceId = `${provider}-${Date.now().toString(36)}`;
    const base = {
      id: instanceId,
      label: `Account ${providerConfig.instances.length + 1}`,
      enabled: true,
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
    const providerConfig = settings.providers[provider];
    updateProviderConfig(provider, {
      ...providerConfig,
      instances: providerConfig.instances.map((instance) =>
        instance.id === instanceId ? Object.assign({}, instance, patch) : instance,
      ),
    } as UnifiedSettings["providers"][typeof provider]);
  };

  const removeProviderInstance = (providerCard: ProviderCard, instanceId: string) => {
    const provider = providerCard.provider;
    const providerConfig = settings.providers[provider];
    updateProviderConfig(provider, {
      ...providerConfig,
      instances: providerConfig.instances.filter((instance) => instance.id !== instanceId),
    } as UnifiedSettings["providers"][typeof provider]);
  };

  return (
    <SettingsSection
      title="Providers"
      headerAction={
        <div className="flex items-center gap-1.5">
          <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                  disabled={isRefreshingProviders}
                  onClick={() => void refreshProviders()}
                  aria-label="Refresh provider status"
                >
                  {isRefreshingProviders ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-3" />
                  )}
                  Refresh
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh provider status</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      {providerCards.map((providerCard) => {
        const customModelInput = customModelInputByProvider[providerCard.provider];
        const customModelError = customModelErrorByProvider[providerCard.provider] ?? null;
        const providerDisplayName =
          PROVIDER_DISPLAY_NAMES[providerCard.provider] ?? providerCard.title;
        const isUpgrading = isUpgradingProvider(providerCard.provider);

        return (
          <div key={providerCard.provider} className="border-t border-border/45 first:border-t-0">
            <div className="px-3 py-3 sm:px-4">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex min-h-5 min-w-0 items-center gap-1.5">
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", providerCard.statusStyle.dot)}
                    />
                    <h3 className="min-w-0 truncate text-[13px] font-medium tracking-tight text-foreground/90">
                      {providerDisplayName}
                    </h3>
                    {providerCard.versionLabel ? (
                      <code className="shrink-0 text-[11px] text-muted-foreground/50">
                        {providerCard.versionLabel}
                      </code>
                    ) : null}
                    {providerCard.isDirty ? (
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        <SettingResetButton
                          label={`${providerDisplayName} provider settings`}
                          onClick={() => {
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                [providerCard.provider]:
                                  DEFAULT_UNIFIED_SETTINGS.providers[providerCard.provider],
                              },
                            });
                            setCustomModelErrorByProvider((existing) => ({
                              ...existing,
                              [providerCard.provider]: null,
                            }));
                          }}
                        />
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[12px] leading-relaxed text-muted-foreground/65">
                    {providerCard.summary.headline}
                    {providerCard.summary.detail ? ` - ${providerCard.summary.detail}` : null}
                  </p>
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 md:w-auto md:justify-end">
                  {providerCard.canUpgradeCli ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                            disabled={isUpgrading}
                            onClick={() =>
                              upgradeProviderCli(providerCard.provider, providerCard.provider)
                            }
                            aria-label={`Upgrade ${providerDisplayName} CLI`}
                          >
                            {isUpgrading ? (
                              <LoaderIcon className="size-3 animate-spin" />
                            ) : (
                              <RefreshCwIcon className="size-3" />
                            )}
                            {isUpgrading ? "Upgrading" : "Upgrade"}
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Upgrade {providerDisplayName} CLI</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-[var(--control-radius)] px-2 text-xs text-muted-foreground/55 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
                    onClick={() =>
                      setOpenProviderDetails((existing) => ({
                        ...existing,
                        [providerCard.provider]: !existing[providerCard.provider],
                      }))
                    }
                    aria-label={`Toggle ${providerDisplayName} details`}
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        openProviderDetails[providerCard.provider] && "rotate-180",
                      )}
                    />
                  </Button>
                  <Switch
                    checked={providerCard.providerConfig.enabled}
                    onCheckedChange={(checked) => {
                      const isDisabling = !checked;
                      const shouldClearModelSelection =
                        isDisabling && textGenProvider === providerCard.provider;
                      updateSettings({
                        providers: {
                          ...settings.providers,
                          [providerCard.provider]: {
                            ...settings.providers[providerCard.provider],
                            enabled: Boolean(checked),
                          },
                        },
                        ...(shouldClearModelSelection
                          ? {
                              textGenerationModelSelection:
                                DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                            }
                          : {}),
                      });
                    }}
                    aria-label={`Enable ${providerDisplayName}`}
                  />
                </div>
              </div>
            </div>

            <Collapsible
              open={openProviderDetails[providerCard.provider]}
              onOpenChange={(open) =>
                setOpenProviderDetails((existing) => ({
                  ...existing,
                  [providerCard.provider]: open,
                }))
              }
            >
              <CollapsibleContent>
                <div className="space-y-0 bg-background/25">
                  <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                    <label
                      htmlFor={`provider-install-${providerCard.provider}-binary-path`}
                      className="block"
                    >
                      <span className="text-[12px] font-medium text-foreground/85">
                        {providerDisplayName} binary path
                      </span>
                      <Input
                        id={`provider-install-${providerCard.provider}-binary-path`}
                        className="mt-1.5"
                        value={providerCard.binaryPathValue}
                        onChange={(event) =>
                          updateSettings({
                            providers: {
                              ...settings.providers,
                              [providerCard.provider]: {
                                ...settings.providers[providerCard.provider],
                                binaryPath: event.target.value,
                              },
                            },
                          })
                        }
                        placeholder={providerCard.binaryPlaceholder}
                        spellCheck={false}
                      />
                      <span className="mt-1 block text-[11px] text-muted-foreground/60">
                        {providerCard.binaryDescription}
                      </span>
                    </label>
                  </div>

                  {providerCard.runtimes && providerCard.runtimes.length > 0 ? (
                    <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                      <div className="text-[12px] font-medium text-foreground/85">Runtimes</div>
                      <div className="mt-2 space-y-2">
                        {providerCard.runtimes.map((runtime) => {
                          const upgradingRuntime = isUpgradingRuntime(
                            providerCard.provider,
                            runtime.id,
                          );
                          return (
                            <div
                              key={`${providerCard.provider}:${runtime.id}`}
                              className="flex items-center justify-between gap-3 rounded-[var(--control-radius)] border border-border/40 px-3 py-2"
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
                                  onClick={() =>
                                    upgradeProviderCli(providerCard.provider, runtime.id)
                                  }
                                >
                                  {upgradingRuntime ? (
                                    <LoaderIcon className="size-3 animate-spin" />
                                  ) : (
                                    <RefreshCwIcon className="size-3" />
                                  )}
                                  {upgradingRuntime ? "Upgrading" : "Upgrade"}
                                </Button>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {providerCard.provider === "githubCopilot" ? (
                    <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                      <label
                        htmlFor={`provider-install-${providerCard.provider}-cli-url`}
                        className="block"
                      >
                        <span className="text-[12px] font-medium text-foreground/85">
                          Copilot CLI server URL
                        </span>
                        <Input
                          id={`provider-install-${providerCard.provider}-cli-url`}
                          className="mt-1.5"
                          value={providerCard.cliUrlValue ?? ""}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                githubCopilot: {
                                  ...settings.providers.githubCopilot,
                                  cliUrl: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.cliUrlPlaceholder}
                          spellCheck={false}
                        />
                        {providerCard.cliUrlDescription ? (
                          <span className="mt-1 block text-[11px] text-muted-foreground/60">
                            {providerCard.cliUrlDescription}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  ) : null}

                  {providerCard.homePathKey ? (
                    <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                      <label
                        htmlFor={`provider-install-${providerCard.homePathKey}`}
                        className="block"
                      >
                        <span className="text-[12px] font-medium text-foreground/85">
                          CODEX_HOME path
                        </span>
                        <Input
                          id={`provider-install-${providerCard.homePathKey}`}
                          className="mt-1.5"
                          value={codexHomePath}
                          onChange={(event) =>
                            updateSettings({
                              providers: {
                                ...settings.providers,
                                codex: {
                                  ...settings.providers.codex,
                                  homePath: event.target.value,
                                },
                              },
                            })
                          }
                          placeholder={providerCard.homePlaceholder}
                          spellCheck={false}
                        />
                        {providerCard.homeDescription ? (
                          <span className="mt-1 block text-[11px] text-muted-foreground/60">
                            {providerCard.homeDescription}
                          </span>
                        ) : null}
                      </label>
                    </div>
                  ) : null}

                  <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[12px] font-medium text-foreground/85">
                          Provider instances
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground/60">
                          Add named accounts with isolated config paths or env credentials.
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-[var(--control-radius)] gap-1.5 px-2 text-xs"
                        onClick={() => addProviderInstance(providerCard)}
                      >
                        <PlusIcon className="size-3" />
                        Add
                      </Button>
                    </div>

                    {providerCard.providerConfig.instances.length > 0 ? (
                      <div className="mt-3 space-y-3">
                        {providerCard.providerConfig.instances.map((instance) => {
                          const pathLabel = instancePathLabel(providerCard.provider);
                          const pathValue =
                            "homePath" in instance
                              ? instance.homePath
                              : "configDir" in instance
                                ? instance.configDir
                                : "agentDir" in instance
                                  ? instance.agentDir
                                  : "";
                          return (
                            <div
                              key={`${providerCard.provider}:${instance.id}`}
                              className="rounded-[var(--control-radius)] border border-border/45 p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <Input
                                    value={instance.label}
                                    onChange={(event) =>
                                      updateProviderInstance(providerCard, instance.id, {
                                        label: event.target.value,
                                      })
                                    }
                                    placeholder="Instance name"
                                  />
                                </div>
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
                                  className="size-7 rounded-[var(--control-radius)] text-muted-foreground/60 hover:text-foreground"
                                  onClick={() => removeProviderInstance(providerCard, instance.id)}
                                  aria-label={`Remove ${instance.label}`}
                                >
                                  <XIcon className="size-3.5" />
                                </Button>
                              </div>

                              <div className="mt-2 grid gap-2 md:grid-cols-2">
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
                                {providerCard.provider === "githubCopilot" &&
                                "cliUrl" in instance ? (
                                  <label className="block">
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
                              </div>

                              <label className="mt-2 block">
                                <span className="text-[11px] font-medium text-foreground/75">
                                  Launch env
                                </span>
                                <Textarea
                                  className="mt-1"
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
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="border-t border-border/45 px-3 py-3 sm:px-4">
                    <div className="text-[12px] font-medium text-foreground/85">Models</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/60">
                      {providerCard.models.length} model
                      {providerCard.models.length === 1 ? "" : "s"} available.
                    </div>
                    <div
                      ref={(element) => {
                        modelListRefs.current[providerCard.provider] = element;
                      }}
                      className="mt-2 max-h-40 overflow-y-auto pb-1"
                    >
                      {providerCard.models.map((model) => {
                        const caps = model.capabilities;
                        const capLabels: string[] = [];
                        if (caps?.supportsFastMode) capLabels.push("Fast mode");
                        if (caps?.supportsThinkingToggle) capLabels.push("Thinking");
                        if (caps?.reasoningEffortLevels && caps.reasoningEffortLevels.length > 0) {
                          capLabels.push("Reasoning");
                        }
                        const hasDetails = capLabels.length > 0 || model.name !== model.slug;

                        return (
                          <div
                            key={`${providerCard.provider}:${model.slug}`}
                            className="flex items-center gap-2 border-t border-border/25 py-1.5 first:border-t-0"
                          >
                            <span className="min-w-0 truncate text-xs text-foreground/90">
                              {model.name}
                            </span>
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
                                  <div className="space-y-1">
                                    <code className="block text-[11px] text-foreground">
                                      {model.slug}
                                    </code>
                                    {capLabels.length > 0 ? (
                                      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                                        {capLabels.map((label) => (
                                          <span
                                            key={label}
                                            className="text-[10px] text-muted-foreground"
                                          >
                                            {label}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </TooltipPopup>
                              </Tooltip>
                            ) : null}
                            {model.isCustom ? (
                              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                                <span className="text-[10px] text-muted-foreground/70">custom</span>
                                <button
                                  type="button"
                                  className="text-muted-foreground transition-colors hover:text-foreground"
                                  aria-label={`Remove ${model.slug}`}
                                  onClick={() =>
                                    removeCustomModel(providerCard.provider, model.slug)
                                  }
                                >
                                  <XIcon className="size-3" />
                                </button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Input
                        id={`custom-model-${providerCard.provider}`}
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
                          addCustomModel(providerCard.provider);
                        }}
                        placeholder={resolveCustomModelPlaceholder(providerCard.provider)}
                        spellCheck={false}
                      />
                      <Button
                        className="shrink-0"
                        variant="outline"
                        onClick={() => addCustomModel(providerCard.provider)}
                      >
                        <PlusIcon className="size-3.5" />
                        Add
                      </Button>
                    </div>

                    {customModelError ? (
                      <p className="mt-2 text-xs text-destructive">{customModelError}</p>
                    ) : null}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        );
      })}
    </SettingsSection>
  );
}
