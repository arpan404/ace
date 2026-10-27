import { z } from "zod";
import { codexNeedsCatalog, type CodexCatalogSource, type CodexToolFacts } from "./tool-search.ts";

type Request = (method: string, params: unknown) => Promise<unknown>;
type Schedule = (callback: () => void, delayMs: number) => () => void;
type Catalog = readonly string[] | undefined;

const ConfigRead = z.object({
  config: z
    .object({
      model: z.string().max(512).nullish(),
      model_provider: z.string().max(256).nullish(),
      model_catalog_json: z.string().max(4096).nullish(),
      model_providers: z
        .record(z.string(), z.object({ model_catalog_url: z.string().max(4096).nullish() }).loose())
        .nullish(),
      features: z.record(z.string(), z.unknown()).nullish(),
    })
    .loose(),
});
const ModelPage = z.object({
  data: z.array(z.object({ id: z.string().max(512), model: z.string().max(512) }).loose()),
  nextCursor: z.string().max(4096).nullish(),
});
/** Enough for any catalog Codex ships or fetches; a longer one is read as unknown. */
const maxPages = 10;

/**
 * How long a thread start waits for these facts. Codex answers both reads locally in
 * milliseconds (config from disk, the catalog from its cache); only a cold catalog goes online,
 * under Codex's own 5-second refresh limit. Past this the thread starts with every tool listed,
 * as before discovery existed, and a catalog read still running fills the host's cache.
 */
export const toolFactsDeadlineMs = 2_500;

/**
 * Catalogs one app-server has served, by the config that chose them. A catalog rarely changes
 * while its app-server runs; a config naming another provider, file or URL reads afresh, and a
 * read that failed is forgotten so the next thread retries.
 */
export class CodexCatalogCache {
  readonly #entries = new Map<string, Promise<Catalog>>();
  get size(): number {
    return this.#entries.size;
  }
  read(key: string, load: () => Promise<Catalog>): Promise<Catalog> {
    const cached = this.#entries.get(key);
    if (cached) return cached;
    return this.put(key, load());
  }
  put(key: string, catalog: Promise<Catalog>): Promise<Catalog> {
    const existing = this.#entries.get(key);
    if (existing) return existing;
    this.#entries.set(key, catalog);
    void catalog.then((slugs) => {
      if (slugs === undefined && this.#entries.get(key) === catalog) this.#entries.delete(key);
    });
    return catalog;
  }
}

export interface ToolFactsInput {
  readonly request: Request;
  readonly cwd: string;
  /** The model the thread asks for; absent means Codex's configured one. */
  readonly model: string | undefined;
  /** The session's own signal: aborting it fails the read instead of guessing. */
  readonly signal: AbortSignal;
  readonly schedule: Schedule;
  readonly catalogs: CodexCatalogCache;
}

/**
 * What decides whether Codex defers ace's tools for this thread, read from the app-server before
 * the thread starts: the model (`model`, else Codex's configured one), the provider, the
 * features, which catalog applies, and that catalog with hidden models. A read that fails or
 * misses the deadline leaves its fact unknown, which keeps every tool listed.
 */
export async function readCodexToolFacts(input: ToolFactsInput): Promise<CodexToolFacts> {
  const { request, cwd, signal, catalogs } = input;
  let cancel: (() => void) | undefined;
  const late = new Promise<undefined>((resolve) => {
    cancel = input.schedule(() => resolve(undefined), toolFactsDeadlineMs);
  });
  try {
    const within = <T>(read: Promise<T>) => Promise.race([read, late]);
    const loadCatalog = () => settle(() => readCatalog(request));
    // The catalog does not depend on the thread: on a host that has none yet, read it beside
    // the config. Without a requested model the config may decide alone, so it goes first.
    const early = input.model && catalogs.size === 0 ? loadCatalog() : undefined;
    const config = await within(
      settle(async () =>
        ConfigRead.parse(await request("config/read", { cwd, includeLayers: false })),
      ),
    );
    signal.throwIfAborted();
    const facts = configFacts(input.model, config?.config);
    if (!codexNeedsCatalog(facts)) return facts;
    const key = catalogKey(facts.provider, config?.config);
    const catalog = await within(
      early ? catalogs.put(key, early) : catalogs.read(key, loadCatalog),
    );
    signal.throwIfAborted();
    return { ...facts, catalog };
  } finally {
    cancel?.();
  }
}

type Config = z.infer<typeof ConfigRead>["config"];

function configFacts(model: string | undefined, config: Config | undefined): CodexToolFacts {
  return {
    model: model || config?.model || undefined,
    provider: config?.model_provider ?? undefined,
    features: config?.features ?? undefined,
    catalogSource: config ? catalogSource(config) : undefined,
  };
}

/** Codex prefers a configured catalog file over the provider's catalog URL. */
function catalogSource(config: Config): CodexCatalogSource {
  if (config.model_catalog_json) return "file";
  return providerCatalogUrl(config) ? "provider" : "codex";
}
function providerCatalogUrl(config: Config): string | undefined {
  const provider = config.model_provider ?? "openai";
  return config.model_providers?.[provider]?.model_catalog_url ?? undefined;
}
function catalogKey(provider: string | undefined, config: Config | undefined): string {
  return JSON.stringify([
    provider ?? "openai",
    config?.model_catalog_json ?? null,
    config ? (providerCatalogUrl(config) ?? null) : null,
  ]);
}

async function readCatalog(request: Request): Promise<string[] | undefined> {
  const slugs: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = ModelPage.parse(
      await request("model/list", { includeHidden: true, limit: 100, cursor: cursor ?? null }),
    );
    for (const entry of result.data) slugs.push(entry.model, entry.id);
    if (!result.nextCursor) return slugs;
    cursor = result.nextCursor;
  }
  return undefined;
}

/** A fact that could not be read is unknown; the caller checks its own cancellation. */
async function settle<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
