import {
  readyProviders,
  resolveUtilityModel,
  utilityProviders,
  type UtilityModel,
} from "@ace/models";
import type {
  CatalogModel,
  ProviderKind,
  ProviderStatus,
  ThreadId,
  UtilityModelChoice,
} from "@ace/protocol";
import type { SettingsService } from "@ace/settings";
import type { Store } from "./store.ts";
import { ThreadTitles } from "./thread-titles.ts";
import type { UtilityCli } from "./utility-cli.ts";

export interface UtilityModelsOptions {
  /** The person's saved choice on this daemon, or null for the ready-provider default. */
  choice(): Promise<UtilityModelChoice | null | undefined>;
  statuses(): readonly ProviderStatus[];
  /** The retained catalog for one provider; never starts discovery. */
  models(provider: ProviderKind): readonly CatalogModel[];
  run: UtilityCli;
}
/** Per-use bounds: generations are short, so their output and time are capped. */
export interface UtilityLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}
export const titleLimits: UtilityLimits = { timeoutMs: 45_000, maxOutputBytes: 262_144 };
export const draftLimits: UtilityLimits = { timeoutMs: 120_000, maxOutputBytes: 1_048_576 };

/**
 * The daemon's utility model: which provider, account and model write titles and drafts, and
 * one short run on it. With no model available, generation rejects with `utility_unavailable`
 * and callers keep their non-model fallback.
 */
export class UtilityModels {
  private readonly options: UtilityModelsOptions;
  constructor(options: UtilityModelsOptions) {
    this.options = options;
  }
  async resolve(): Promise<UtilityModel | undefined> {
    const choice = await this.options.choice();
    const statuses = this.options.statuses();
    const models = utilityProviders.flatMap((provider) => this.options.models(provider));
    return resolveUtilityModel({ choice, ready: readyProviders(statuses), models });
  }
  async generate(prompt: string, signal: AbortSignal, limits: UtilityLimits): Promise<string> {
    const target = await this.resolve();
    if (!target) throw new Error("utility_unavailable");
    signal.throwIfAborted();
    return this.options.run(target, { prompt, signal, ...limits });
  }
}

export interface UtilityService {
  models: UtilityModels;
  titles: ThreadTitles;
}
/**
 * The daemon's utility model and title generation. The choice is this daemon's global
 * `generation.model` setting, so each daemon keeps its own.
 */
export function createUtility(deps: {
  settings: Pick<SettingsService, "get"> | undefined;
  statuses(): readonly ProviderStatus[];
  models(provider: ProviderKind): readonly CatalogModel[];
  run: UtilityCli;
  store: Store;
  now(): number;
  onTitleFailure?(threadId: ThreadId, error: unknown): void;
}): UtilityService {
  const models = new UtilityModels({
    choice: async () => (await deps.settings?.get("generation.model"))?.value,
    statuses: deps.statuses,
    models: deps.models,
    run: deps.run,
  });
  const titles = new ThreadTitles({
    store: deps.store,
    now: deps.now,
    generate: (prompt, signal) => models.generate(prompt, signal, titleLimits),
    ...(deps.onTitleFailure ? { onFailure: deps.onTitleFailure } : {}),
  });
  return { models, titles };
}
