/**
 * OpenCode SDK helpers — model listing and model id parsing for OpenCode HTTP API.
 *
 * @module opencodeSdk
 */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ServerProviderModel } from "@ace/contracts";

export const OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT = 100;

const OPENCODE_PROVIDER_LIST_CACHE_TTL_MS = 30_000;

interface OpenCodeListedModel {
  readonly id: string;
  readonly name: string;
  readonly family?: string;
  readonly release_date: string;
  readonly attachment: boolean;
  readonly reasoning: boolean;
  readonly tool_call: boolean;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
    readonly context_over_200k?: {
      readonly input: number;
      readonly output: number;
      readonly cache_read?: number;
      readonly cache_write?: number;
    };
  };
  readonly experimental?: boolean;
  readonly status?: "alpha" | "beta" | "deprecated";
  readonly variants?: Record<string, Record<string, unknown>>;
}

interface OpenCodeListedProvider {
  readonly id: string;
  readonly name: string;
  readonly env: ReadonlyArray<string>;
  readonly models: Record<string, OpenCodeListedModel>;
}

interface OpenCodeProviderListResponse {
  readonly all: ReadonlyArray<OpenCodeListedProvider>;
  readonly default: Record<string, string>;
  readonly connected: ReadonlyArray<string>;
}

interface OpenCodeConfigProvidersResponse {
  readonly providers: ReadonlyArray<OpenCodeListedProvider>;
  readonly default: Record<string, string>;
}

interface OpenCodeCatalogEntry {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly slug: string;
  readonly name: string;
  readonly family: string | null;
  readonly releaseDate: string;
  readonly releaseTimestamp: number;
  readonly status: OpenCodeListedModel["status"];
  readonly experimental: boolean;
  readonly isDefaultModel: boolean;
  readonly isConnectedProvider: boolean;
  readonly variants: ReadonlyArray<string>;
}

interface OpenCodeProviderListCacheEntry {
  value?: OpenCodeProviderListResponse;
  expiresAt: number;
  pending?: Promise<OpenCodeProviderListResponse>;
}

interface OpenCodeConfigProvidersCacheEntry {
  value?: OpenCodeConfigProvidersResponse;
  expiresAt: number;
  pending?: Promise<OpenCodeConfigProvidersResponse>;
}

export interface OpenCodeModelListResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly totalModels: number;
  readonly truncated: boolean;
}

export interface OpenCodeModelSearchResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly totalModels: number;
  readonly nextOffset: number | null;
  readonly hasMore: boolean;
}

const openCodeProviderListCache = new Map<string, OpenCodeProviderListCacheEntry>();
const openCodeConfigProvidersCache = new Map<string, OpenCodeConfigProvidersCacheEntry>();

export function createOpenCodeSdkClient(input: {
  readonly baseUrl: string;
  readonly directory?: string;
}): OpencodeClient {
  return createOpencodeClient({
    baseUrl: input.baseUrl,
    ...(input.directory ? { directory: input.directory } : {}),
  });
}

function parseReleaseTimestamp(releaseDate: string): number {
  const timestamp = Date.parse(releaseDate);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toCatalogEntry(
  provider: OpenCodeListedProvider,
  model: OpenCodeListedModel,
  defaults: Record<string, string>,
  connectedProviderIds: ReadonlySet<string>,
): OpenCodeCatalogEntry {
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    slug: `${provider.id}/${model.id}`,
    name: `${provider.name}: ${model.name}`,
    family:
      typeof model.family === "string" && model.family.trim().length > 0 ? model.family : null,
    releaseDate: model.release_date,
    releaseTimestamp: parseReleaseTimestamp(model.release_date),
    status: model.status,
    experimental: model.experimental === true,
    isDefaultModel: defaults[provider.id] === model.id,
    isConnectedProvider: connectedProviderIds.has(provider.id),
    variants: Object.keys(model.variants ?? {}).filter((variant) => variant.trim().length > 0),
  };
}

function toVariantLabel(variant: string): string {
  return variant
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toServerProviderModel(entry: OpenCodeCatalogEntry): ServerProviderModel {
  const variantOptions = entry.variants.map((variant) => ({
    value: variant,
    label: toVariantLabel(variant),
    ...(variant === "default" ? { isDefault: true } : {}),
  }));
  const defaultVariantExists = variantOptions.some((variant) => variant.isDefault);
  const contextWindowOptions =
    variantOptions.length > 0
      ? defaultVariantExists
        ? variantOptions
        : variantOptions.map((variant, index) =>
            index === 0
              ? { value: variant.value, label: variant.label, isDefault: true }
              : { value: variant.value, label: variant.label },
          )
      : [];

  return {
    slug: entry.slug,
    name: entry.name,
    isCustom: false,
    capabilities:
      contextWindowOptions.length > 0
        ? {
            reasoningEffortLevels: [],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions,
            promptInjectedEffortLevels: [],
          }
        : null,
  };
}

function compareCatalogEntries(left: OpenCodeCatalogEntry, right: OpenCodeCatalogEntry): number {
  if (left.isDefaultModel !== right.isDefaultModel) {
    return left.isDefaultModel ? -1 : 1;
  }
  if (left.isConnectedProvider !== right.isConnectedProvider) {
    return left.isConnectedProvider ? -1 : 1;
  }
  if ((left.status === "deprecated") !== (right.status === "deprecated")) {
    return left.status === "deprecated" ? 1 : -1;
  }
  if (left.experimental !== right.experimental) {
    return left.experimental ? 1 : -1;
  }
  if (left.releaseTimestamp !== right.releaseTimestamp) {
    return right.releaseTimestamp - left.releaseTimestamp;
  }
  return left.name.localeCompare(right.name);
}

function compareCatalogEntriesByReleaseDate(
  left: OpenCodeCatalogEntry,
  right: OpenCodeCatalogEntry,
): number {
  if (left.releaseTimestamp !== right.releaseTimestamp) {
    return right.releaseTimestamp - left.releaseTimestamp;
  }
  return compareCatalogEntries(left, right);
}

function collectCatalogEntries(
  data: OpenCodeProviderListResponse,
): ReadonlyArray<OpenCodeCatalogEntry> {
  const connectedProviderIds = new Set(data.connected);
  const entries: OpenCodeCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const provider of data.all) {
    for (const model of Object.values(provider.models)) {
      const entry = toCatalogEntry(provider, model, data.default, connectedProviderIds);
      if (seen.has(entry.slug)) {
        continue;
      }
      seen.add(entry.slug);
      entries.push(entry);
    }
  }

  return entries;
}

function searchScore(entry: OpenCodeCatalogEntry, query: string): number {
  const normalizedQuery = query.toLowerCase();
  const slug = entry.slug.toLowerCase();
  const name = entry.name.toLowerCase();
  const providerName = entry.providerName.toLowerCase();
  const family = entry.family?.toLowerCase() ?? "";

  if (slug === normalizedQuery || name === normalizedQuery) {
    return 0;
  }
  if (slug.startsWith(normalizedQuery)) {
    return 1;
  }
  if (name.startsWith(normalizedQuery)) {
    return 2;
  }
  if (family.startsWith(normalizedQuery)) {
    return 3;
  }
  if (providerName.startsWith(normalizedQuery)) {
    return 4;
  }
  if (slug.includes(normalizedQuery)) {
    return 5;
  }
  if (name.includes(normalizedQuery)) {
    return 6;
  }
  if (family.includes(normalizedQuery)) {
    return 7;
  }
  return providerName.includes(normalizedQuery) ? 8 : Number.POSITIVE_INFINITY;
}

async function loadOpenCodeProviderList(baseUrl: string): Promise<OpenCodeProviderListResponse> {
  const now = Date.now();
  const cached = openCodeProviderListCache.get(baseUrl);
  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const request = (async () => {
    const client = createOpenCodeSdkClient({ baseUrl });
    const listed = await client.provider.list();
    if (listed.error) {
      throw new Error(
        typeof listed.error === "object" && listed.error && "message" in listed.error
          ? String((listed.error as { message?: string }).message)
          : "OpenCode provider list failed",
      );
    }

    const body = listed.data as OpenCodeProviderListResponse | undefined;
    if (!body || !Array.isArray(body.all)) {
      throw new Error("Unexpected OpenCode provider list response.");
    }

    openCodeProviderListCache.set(baseUrl, {
      value: body,
      expiresAt: Date.now() + OPENCODE_PROVIDER_LIST_CACHE_TTL_MS,
    });

    return body;
  })().finally(() => {
    const latest = openCodeProviderListCache.get(baseUrl);
    if (!latest) {
      return;
    }
    if (latest.pending) {
      openCodeProviderListCache.set(baseUrl, {
        ...(latest.value ? { value: latest.value } : {}),
        expiresAt: latest.expiresAt,
      });
    }
  });

  openCodeProviderListCache.set(baseUrl, {
    ...(cached?.value ? { value: cached.value } : {}),
    expiresAt: cached?.expiresAt ?? 0,
    pending: request,
  });

  return request;
}

async function loadOpenCodeConfigProviders(
  baseUrl: string,
): Promise<OpenCodeConfigProvidersResponse> {
  const now = Date.now();
  const cached = openCodeConfigProvidersCache.get(baseUrl);
  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }
  if (cached?.pending) {
    return cached.pending;
  }

  const request = (async () => {
    const client = createOpenCodeSdkClient({ baseUrl });
    const listed = await client.config.providers();
    if (listed.error) {
      throw new Error(
        typeof listed.error === "object" && listed.error && "message" in listed.error
          ? String((listed.error as { message?: string }).message)
          : "OpenCode config providers failed",
      );
    }

    const body = listed.data as OpenCodeConfigProvidersResponse | undefined;
    if (!body || !Array.isArray(body.providers)) {
      throw new Error("Unexpected OpenCode config providers response.");
    }

    openCodeConfigProvidersCache.set(baseUrl, {
      value: body,
      expiresAt: Date.now() + OPENCODE_PROVIDER_LIST_CACHE_TTL_MS,
    });

    return body;
  })().finally(() => {
    const latest = openCodeConfigProvidersCache.get(baseUrl);
    if (!latest) {
      return;
    }
    if (latest.pending) {
      openCodeConfigProvidersCache.set(baseUrl, {
        ...(latest.value ? { value: latest.value } : {}),
        expiresAt: latest.expiresAt,
      });
    }
  });

  openCodeConfigProvidersCache.set(baseUrl, {
    ...(cached?.value ? { value: cached.value } : {}),
    expiresAt: cached?.expiresAt ?? 0,
    pending: request,
  });

  return request;
}

function toProviderListResponseFromConfigProviders(
  data: OpenCodeConfigProvidersResponse,
  connectedProviderIds?: ReadonlyArray<string>,
): OpenCodeProviderListResponse {
  const configuredProviderIds = new Set(data.providers.map((provider) => provider.id));
  const connected =
    connectedProviderIds && connectedProviderIds.length > 0
      ? connectedProviderIds.filter((providerId) => configuredProviderIds.has(providerId))
      : data.providers.map((provider) => provider.id);
  return {
    all: data.providers,
    default: data.default ?? {},
    connected,
  };
}

/**
 * Flatten OpenCode provider listing into picker slugs `providerId/modelId`.
 */
export function openCodeModelsFromProviderList(
  data: OpenCodeProviderListResponse,
  options?: {
    readonly maxModels?: number;
  },
): OpenCodeModelListResult {
  const maxModels = options?.maxModels ?? Number.POSITIVE_INFINITY;
  const entries = collectCatalogEntries(data);
  if (entries.length === 0) {
    return {
      models: [],
      totalModels: 0,
      truncated: false,
    };
  }
  const latestModel = [...entries]
    .filter((entry) => entry.status !== "deprecated" && !entry.experimental)
    .toSorted(compareCatalogEntriesByReleaseDate)[0];
  const rankedEntries = [...entries].toSorted(compareCatalogEntries);

  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();

  if (latestModel) {
    seen.add(latestModel.slug);
    models.push(toServerProviderModel(latestModel));
  }

  for (const entry of rankedEntries) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    models.push(toServerProviderModel(entry));
    if (models.length >= maxModels) {
      break;
    }
  }

  return {
    models: models.slice(0, maxModels),
    totalModels: entries.length,
    truncated: entries.length > Math.min(models.length, maxModels),
  };
}

export function searchOpenCodeModelsFromProviderList(
  data: OpenCodeProviderListResponse,
  options: {
    readonly query: string;
    readonly limit: number;
    readonly offset: number;
  },
): OpenCodeModelSearchResult {
  const normalizedQuery = options.query.trim().toLowerCase();
  const limit = Math.max(
    1,
    Math.min(OPENCODE_PROVIDER_SEARCH_PAGE_LIMIT, Math.trunc(options.limit)),
  );
  const offset = Math.max(0, Math.trunc(options.offset));
  const matchingEntries = collectCatalogEntries(data)
    .filter((entry) => {
      if (normalizedQuery.length === 0) {
        return true;
      }
      return Number.isFinite(searchScore(entry, normalizedQuery));
    })
    .toSorted((left, right) => {
      const leftScore = normalizedQuery.length === 0 ? 0 : searchScore(left, normalizedQuery);
      const rightScore = normalizedQuery.length === 0 ? 0 : searchScore(right, normalizedQuery);
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }
      return compareCatalogEntries(left, right);
    });

  const page = matchingEntries.slice(offset, offset + limit).map(toServerProviderModel);
  const nextOffset = offset + page.length < matchingEntries.length ? offset + page.length : null;

  return {
    models: page,
    totalModels: matchingEntries.length,
    nextOffset,
    hasMore: nextOffset !== null,
  };
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): { providerID: string; modelID: string } | null {
  if (typeof slug !== "string") return null;
  const trimmed = slug.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const providerID = trimmed.slice(0, slash).trim();
  const modelID = trimmed.slice(slash + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

export function resolveOpenCodeModelForPrompt(input: {
  readonly modelSlug: string;
  readonly defaults: Record<string, string>;
}): { providerID: string; modelID: string } {
  const trimmed = input.modelSlug.trim();
  if (trimmed === "" || trimmed === "auto") {
    const entries = Object.entries(input.defaults);
    const first = entries[0];
    if (!first) {
      return { providerID: "openai", modelID: "gpt-4.1" };
    }
    return { providerID: first[0], modelID: first[1] };
  }
  const parsed = parseOpenCodeModelSlug(trimmed);
  if (parsed) {
    return parsed;
  }
  return { providerID: "openai", modelID: trimmed };
}

export function extractTextPartsFromPromptResponse(
  parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export type OpenCodeProbeSuccess = {
  readonly version: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly totalModelCount: number;
  readonly modelsTruncated: boolean;
  readonly defaultModels: Record<string, string>;
  readonly connectedProviderIds: ReadonlyArray<string>;
};

export async function probeOpenCodeSdk(baseUrl: string): Promise<OpenCodeProbeSuccess> {
  const client = createOpenCodeSdkClient({ baseUrl });
  const health = await client.global.health();
  if (health.error) {
    throw new Error(
      typeof health.error === "object" && health.error && "message" in health.error
        ? String((health.error as { message?: string }).message)
        : "OpenCode health check failed",
    );
  }
  const version =
    health.data && typeof health.data === "object" && "version" in health.data
      ? String((health.data as { version?: string }).version ?? "unknown")
      : "unknown";

  const [providerList, configProviders] = await Promise.all([
    loadOpenCodeProviderList(baseUrl),
    loadOpenCodeConfigProviders(baseUrl),
  ]);
  const modelCatalog = toProviderListResponseFromConfigProviders(
    configProviders,
    providerList.connected ?? [],
  );
  const modelList = openCodeModelsFromProviderList(modelCatalog);
  return {
    version,
    models: modelList.models,
    totalModelCount: modelList.totalModels,
    modelsTruncated: modelList.truncated,
    defaultModels: modelCatalog.default,
    connectedProviderIds: providerList.connected ?? [],
  };
}

export async function searchOpenCodeModels(
  baseUrl: string,
  options: {
    readonly query: string;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<OpenCodeModelSearchResult> {
  const configProviders = await loadOpenCodeConfigProviders(baseUrl);
  return searchOpenCodeModelsFromProviderList(
    toProviderListResponseFromConfigProviders(configProviders),
    options,
  );
}
