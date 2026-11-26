import { OpenCodeServer, type ServerOptions } from "./server.ts";
import type { OpenCodeClient } from "@opencode/client";
import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import type { Runtime } from "./runtime.ts";
import { metadataFailure } from "./metadata-failure.ts";
import { z } from "zod";
const ModelListData = z.array(z.unknown()).max(8192);
const CatalogPeek = z.object({ data: ModelListData }).passthrough();
const DefaultModelData = z
  .object({ providerID: z.string(), modelID: z.string() })
  .passthrough()
  .nullable();
/**
 * OpenCode 2.4.2 fills a Location's catalog from its providers after the first `/api/model`
 * read, which answers with no models. Its own CLI waits for that activation before listing.
 * Discovery reads again until models arrive, bounded so a Location that has none still answers.
 */
const catalogBudgetMs = 5000;
const catalogPollMs = 50;
const catalogReads = 40;

function withoutModels(payload: unknown): boolean {
  const peek = CatalogPeek.safeParse(payload);
  // A malformed reply is not an empty one: it is validated once and reported as it came.
  return peek.success && peek.data.data.length === 0;
}

function pause(runtime: Runtime, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      cancel();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const cancel = runtime.schedule(done, catalogPollMs);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The location's model catalog once it has answered with models, or its last empty reply. */
async function modelCatalog(
  client: OpenCodeClient,
  directory: string,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<unknown> {
  const started = runtime.monotonic();
  for (let read = 1; ; read++) {
    const payload: unknown = await client.model.list({ location: { directory } }, { signal });
    if (!withoutModels(payload)) return payload;
    if (read >= catalogReads || runtime.monotonic() - started >= catalogBudgetMs) return payload;
    await pause(runtime, signal);
    signal.throwIfAborted();
  }
}

/** Metadata-only, owned lifecycle. No session, prompt, login or credential APIs. */
export async function discoverOpenCodeModels(
  options: ServerOptions,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  const server = new OpenCodeServer(options);
  const abort = () => {
    // The finally below awaits this same close and reports its failure; this copy must only not
    // reject unheard.
    void server.close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let stage = "server startup";
  try {
    signal.throwIfAborted();
    await server.ready(signal);
    signal.throwIfAborted();
    const client = server.scoped(directory, () => {}, signal);
    stage = "/api/model";
    const payload: unknown = await modelCatalog(client, directory, server.runtime, signal);
    const validated = z
      .object({
        location: z.object({ directory: z.literal(directory) }),
        data: ModelListData,
      })
      .passthrough()
      .parse(payload);
    // This is a model selector query, never a config or credential read.
    let configuredDefault: string | undefined;
    try {
      const reply: unknown = await client.model.default({ location: { directory } }, { signal });
      const selected = z
        .object({
          location: z.object({ directory: z.literal(directory) }),
          data: DefaultModelData,
        })
        .parse(reply);
      if (selected.data) configuredDefault = `${selected.data.providerID}/${selected.data.modelID}`;
    } catch {
      signal.throwIfAborted();
      // Older servers may not expose the metadata selector. Catalog policy supplies a fallback.
    }
    return server.redact({ ...validated, ...(configuredDefault ? { configuredDefault } : {}) });
  } catch (error) {
    // Known categories use fixed messages; unknown diagnostics pass through bounded redaction.
    const failure = metadataFailure(error);
    const code = discoveryFailureCode(failure, signal.aborted ? "timeout" : "discovery_failed");
    const reason =
      code === "discovery_failed"
        ? discoveryFailureReason(failure, { env: options.discovery?.env })
        : undefined;
    throw Object.assign(new Error("OpenCode model discovery failed"), {
      code,
      ...(code === "discovery_failed"
        ? {
            detail: server.redact(reason?.startsWith(`${stage}:`) ? reason : `${stage}: ${reason}`),
          }
        : {}),
    });
  } finally {
    signal.removeEventListener("abort", abort);
    await server.close();
  }
}
