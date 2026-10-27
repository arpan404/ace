import type {
  CatalogModel,
  NativePermissionMode,
  ProviderConfiguration,
  ProviderKind,
  ProviderStatus,
} from "@ace/protocol";
import {
  catalogSignal,
  providerDefaultModel,
  favoriteModelKeys,
  catalogModelIds,
  freeModelMarker,
  modelHidden,
  modelKey,
  modelName,
  permissionModeLabel,
  pluralCount,
  providerModelLists,
  providerModelProblems,
  providerHasMcpServers,
  providerNames,
  readinessView,
  signInSteps,
  type ModelCatalog,
  type ReadinessTone,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * A provider's Settings page on the phone, in the web provider page's words: its header
 * (version, update), its status with the one action that fixes it, its sign-in routes, its
 * models and its advanced settings. Pure: the reads arrive as data (`provider-page.ts`), Swift
 * draws the result.
 */

export interface StatusWord {
  label: string;
  token: "done" | "needsYou" | "failed" | "neutral";
}
const tokens: Record<ReadinessTone, StatusWord["token"]> = {
  ready: "done",
  action: "needsYou",
  problem: "failed",
  idle: "neutral",
};

/** The one action that fixes the provider's status. */
export type ProviderFix = "install" | "update" | "sign_in" | "turn_on";
const fixLabels: Record<ProviderFix, string> = {
  install: "Install",
  update: "Update",
  sign_in: "Sign in",
  turn_on: "Turn on",
};

export interface ProviderFact {
  term: string;
  value: string;
  /** A command or path, drawn in monospace and selectable. */
  code: boolean;
}

export interface ModelRow {
  key: string;
  id: string;
  aliases: string[];
  label: string;
  /** "Free · Deprecated · Custom": quiet marks under the name, or null. */
  marks: string | null;
  hidden: boolean;
  starred: boolean;
}

export interface ProviderModelsPage {
  /** Each problem the provider's model groups report, said once. */
  problems: string[];
  /** The default model row, or null when the provider lists no models. */
  defaultModel: {
    label: string;
    /** "Your choice", "Unavailable", or null for the provider's own default. */
    note: string | null;
    resettable: boolean;
    choices: { key: string; id: string; label: string; current: boolean }[];
  } | null;
  /** "12 models": what the picker shows. */
  shown: string;
  /** "14 models": every model the Manage list lists. */
  total: string;
  hideDeprecated: boolean;
  onlyFavourites: boolean;
  groups: { id: string; label: string | null; models: ModelRow[] }[];
  custom: { id: string; displayName: string }[];
}

export interface ProviderPage {
  provider: ProviderKind;
  name: string;
  version: string | null;
  /** "0.161.0 available", "Update available", or null. */
  update: string | null;
  status: StatusWord;
  /** Why it needs attention, or how to get it; null when nothing needs saying. */
  detail: string | null;
  fix: { action: ProviderFix; label: string } | null;
  /** An update is waiting while the fix is something else (signing in): offered beside it. */
  updateToo: boolean;
  missing: boolean;
  off: boolean;
  /** The provider keeps ace accounts (its Accounts page applies). */
  accounts: boolean;
  /** Its sessions take MCP servers ace can list and change (Advanced → MCP servers). */
  mcp: boolean;
  /** Its CLI signs out from here (Advanced → Sign out). */
  signOut: boolean;
  /**
   * Where to add an API key, when its CLI takes one: keys go to the CLI only over the encrypted
   * sign-in channel, which this phone doesn't open, so the page says where instead.
   */
  apiKey: string | null;
  /** The CLI's own sign-in command, for its terminal on the computer. */
  terminal: { run: string; prompt: string | null } | null;
  about: ProviderFact[];
  settings: {
    enabled: boolean;
    /** The CLI path field, or null where there is none (Cursor's SDK, ACP agents). */
    path: string | null;
    /** ACP agents run the command approved when they were added. */
    approvedCommand: string | null;
    /** Cursor's checkpoint budget in MB as saved ("" for the default 32), else null. */
    checkpoint: string | null;
    nativeMode: { value: string; label: string; options: { id: string; label: string }[] } | null;
    /** The CLI can be removed from the computer from here. */
    removable: boolean;
  };
  models: ProviderModelsPage | null;
}

const accountProviders = new Set<ProviderKind>(["claude", "codex", "opencode", "cursor", "pi"]);
/** Providers whose Accounts page applies: Antigravity keeps accounts too, by sign-in method. */
const accountPageProviders = new Set<ProviderKind>([...accountProviders, "antigravity"]);
const aceModes = "";

export interface ProviderPageInput {
  provider: ProviderKind;
  status: ProviderStatus | undefined;
  configuration: ProviderConfiguration | undefined;
  /** Every provider's saved rows, for the stars. */
  configurations: readonly ProviderConfiguration[];
  /** The saved `access.nativeModes` choice for this provider ("" for ace's modes). */
  nativeMode: string;
  /** The provider's own modes; undefined when they couldn't be read. */
  modes: readonly NativePermissionMode[] | undefined;
  /** Undefined when the catalog couldn't be read. */
  catalog: ModelCatalog | undefined;
  /** What this computer is called, for "Add an API key in ace on <computer>". */
  machine: string;
}

export function providerPage(input: ProviderPageInput): ProviderPage {
  const { provider, status } = input;
  const name = providerNames[provider];
  const view = status
    ? readinessView(
        status,
        input.catalog
          ? catalogSignal(input.catalog.models, input.catalog.instances, provider)
          : undefined,
      )
    : undefined;
  const missing = view?.state === "not_installed" || status?.installed === false;
  const off = !missing && (view?.state === "off" || input.configuration?.enabled === false);
  const latest = status?.latestVersion;
  const updateWaiting = !missing && (view?.state === "needs_update" || !!status?.updateAvailable);
  const fix: ProviderFix | undefined = missing
    ? provider === "cursor"
      ? undefined
      : "install"
    : off
      ? "turn_on"
      : view?.primary === "update"
        ? "update"
        : view?.primary === "sign_in" || view?.primary === "reconnect"
          ? "sign_in"
          : updateWaiting
            ? "update"
            : undefined;
  const steps = signInSteps(provider);
  const version = status?.version ? preview(status.version, 64) : null;
  const about: ProviderFact[] = [];
  if (version)
    about.push({
      term: provider === "cursor" ? "SDK version" : "Version",
      value: version,
      code: true,
    });
  about.push(
    provider === "cursor"
      ? { term: "Runs", value: "Cursor SDK, inside ace", code: false }
      : { term: "Runs", value: provider === "acp" ? "ACP agent" : "Its own CLI", code: false },
  );
  if (provider !== "cursor" && status?.path)
    about.push({ term: "Location", value: preview(status.path, 512), code: true });
  if (view?.unreported)
    about.push({
      term: "Sign-in",
      value: "Not reported by this CLI. ace counts it as ready while it lists models.",
      code: false,
    });
  const native = nativeModeRow(input);
  return {
    provider,
    name,
    version,
    update: updateWaiting
      ? latest
        ? `${preview(latest, 64)} available`
        : "Update available"
      : null,
    status: missing
      ? { label: "Not installed", token: "neutral" }
      : off
        ? { label: "Turned off", token: "neutral" }
        : view
          ? { label: view.label, token: tokens[view.tone] }
          : { label: "Checking…", token: "neutral" },
    detail:
      view?.detail && !view.ready && !off
        ? preview(view.detail, 512)
        : view?.summary && view.summary !== view.label && !missing && !off
          ? preview(view.summary, 256)
          : null,
    fix: fix ? { action: fix, label: fixLabels[fix] } : null,
    updateToo: updateWaiting && !!fix && fix !== "update" && fix !== "turn_on",
    missing,
    off,
    accounts: accountPageProviders.has(provider) && !missing,
    mcp: providerHasMcpServers(provider) && !missing,
    signOut: !missing && !!view?.more.includes("sign_out"),
    apiKey:
      !missing && status?.apiKey?.supported
        ? `Add an API key in ace on ${preview(input.machine, 64)}.`
        : null,
    terminal: !missing && steps ? { run: steps.run, prompt: steps.prompt ?? null } : null,
    about: missing ? [] : about,
    settings: {
      enabled: input.configuration?.enabled !== false,
      path:
        provider === "cursor" || provider === "acp"
          ? null
          : (input.configuration?.binaryPath ?? ""),
      approvedCommand:
        provider === "acp" ? "Uses the command approved when the agent was added." : null,
      checkpoint:
        provider === "cursor"
          ? input.configuration?.maxCheckpointMb === undefined
            ? ""
            : String(input.configuration.maxCheckpointMb)
          : null,
      nativeMode: missing ? null : native,
      removable: !missing && provider !== "cursor" && provider !== "acp",
    },
    models: missing || !input.catalog ? null : modelsPage(input, input.catalog),
  };
}

function nativeModeRow(input: ProviderPageInput): ProviderPage["settings"]["nativeMode"] {
  const modes = input.modes ?? [];
  const value = input.nativeMode;
  if (!modes.length && value === aceModes) return null;
  const options = [
    { id: aceModes, label: "Use ace modes" },
    ...modes.map((mode) => ({ id: mode.id, label: preview(permissionModeLabel(mode), 128) })),
  ];
  const chosen = options.find((option) => option.id === value);
  return { value, label: chosen?.label ?? preview(value, 128), options };
}

function modelsPage(input: ProviderPageInput, catalog: ModelCatalog): ProviderModelsPage {
  const { provider, configuration } = input;
  const rows = catalog.models.filter((model) => model.provider === provider);
  const { unique, models, groups } = providerModelLists(rows, catalog.instances, provider);
  const byKey = new Map(unique.map((model) => [modelKey(model.provider, model.id), model]));
  const stars = new Set(favoriteModelKeys(input.configurations, catalogModelIds(catalog.models)));
  const choice = providerDefaultModel(provider, models, rows, configuration?.defaultModel);
  const problems = providerModelProblems(groups, provider, accountProviders.has(provider)).map(
    ({ problem }) => preview(`${problem.message} ${problem.hint}`.trim(), 512),
  );
  return {
    problems,
    defaultModel: choice.choices.length
      ? {
          label: preview(choice.current?.label ?? "None", 128),
          note: choice.missing ? "Unavailable" : choice.current?.userDefault ? "Your choice" : null,
          resettable: choice.missing || !!choice.current?.userDefault,
          choices: choice.choices.slice(0, 200).map((model) => ({
            key: model.key,
            id: model.key.slice(model.key.indexOf("\u0000") + 1),
            label: preview(model.label, 128),
            current: model.key === choice.current?.key,
          })),
        }
      : null,
    shown: pluralCount(unique.filter((model) => !model.hidden).length, "model"),
    total: pluralCount(unique.length, "model"),
    hideDeprecated: configuration?.hideDeprecated !== false,
    onlyFavourites: configuration?.showOnlyFavourites === true,
    groups: groups.map((group) => ({
      id: group.id,
      label: group.label ? preview(group.label, 128) : null,
      models: [...group.current, ...group.legacy].flatMap((entry) => {
        const model = byKey.get(entry.key);
        return model ? [modelRow(model, configuration, stars.has(entry.key))] : [];
      }),
    })),
    custom: (configuration?.customModels ?? []).map((model) => ({
      id: preview(model.id, 256),
      displayName: preview(model.displayName, 256),
    })),
  };
}

function modelRow(
  model: CatalogModel,
  configuration: ProviderConfiguration | undefined,
  starred: boolean,
): ModelRow {
  const label = modelName(model.provider, model.displayName, model.id);
  // The group header already names the source, so a row never repeats it.
  const marks = [
    freeModelMarker({ free: model.free, label }) ? "Free" : undefined,
    model.deprecated ? "Deprecated" : undefined,
    model.custom ? "Custom" : undefined,
  ].filter((mark): mark is string => !!mark);
  return {
    key: modelKey(model.provider, model.id),
    id: model.id,
    aliases: model.aliases ?? [],
    label: preview(label, 128),
    marks: marks.length ? preview(marks.join(" · "), 256) : null,
    hidden: modelHidden(configuration, model),
    starred,
  };
}

/** A provider that isn't on the list of working ones: turned off, or not installed. */
export interface OtherProvider {
  provider: ProviderKind;
  name: string;
  /** How to get it, in the daemon's words, for a missing provider; null otherwise. */
  detail: string | null;
  /** Install from the phone (Cursor's SDK ships with ace and has none). */
  installable: boolean;
}

/** The off and the missing providers, for the Providers list's own sections. */
export function otherProviders(statuses: readonly ProviderStatus[]): {
  off: OtherProvider[];
  missing: OtherProvider[];
} {
  const off: OtherProvider[] = [];
  const missing: OtherProvider[] = [];
  for (const status of statuses) {
    const view = readinessView(status);
    const row = { provider: status.provider, name: providerNames[status.provider] };
    if (view.state === "not_installed")
      missing.push({
        ...row,
        detail: view.detail ? preview(view.detail, 256) : null,
        installable: status.provider !== "cursor",
      });
    else if (view.state === "off") off.push({ ...row, detail: null, installable: false });
  }
  return { off, missing };
}
