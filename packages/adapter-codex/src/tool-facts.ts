import { z } from "zod";
import type { CodexToolFacts } from "./tool-search.ts";

type Request = (method: string, params: unknown) => Promise<unknown>;

const ConfigRead = z.object({
  config: z
    .object({
      model: z.string().max(512).nullish(),
      model_provider: z.string().max(256).nullish(),
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
 * What decides whether Codex defers ace's tools for this thread, read from the app-server before
 * the thread starts: the model (`model`, else Codex's configured one), the provider, the
 * features and the model catalog with hidden models. A read that fails leaves its fact unknown.
 */
export async function readCodexToolFacts(
  request: Request,
  cwd: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<CodexToolFacts> {
  const config = await settle(
    async () => ConfigRead.parse(await request("config/read", { cwd, includeLayers: false })),
    signal,
  );
  const catalog = await settle(() => readCatalog(request), signal);
  return {
    model: model || config?.config.model || undefined,
    provider: config?.config.model_provider ?? undefined,
    features: config?.config.features ?? undefined,
    catalog,
  };
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

/** A fact that could not be read is unknown, unless the session itself is being cancelled. */
async function settle<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}
