import { OpenCodeServer, type ServerOptions } from "./server.ts";
import { discoveryFailureCode, discoveryFailureReason } from "@ace/provider-kit/discovery-failure";
import { metadataFailure } from "./metadata-failure.ts";
import { z } from "zod";
/** Metadata-only, owned lifecycle. No session, prompt, login or credential APIs. */
export async function discoverOpenCodeModels(
  options: ServerOptions,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  const server = new OpenCodeServer(options);
  const abort = () => {
    void server.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  let stage = "server startup";
  try {
    signal.throwIfAborted();
    await server.ready(signal);
    signal.throwIfAborted();
    const client = server.scoped(directory, () => {}, signal);
    stage = "/api/model";
    const payload: unknown = await client.model.list({ location: { directory } }, { signal });
    const validated = z
      .object({
        location: z.object({ directory: z.literal(directory) }),
        data: z.array(z.unknown()).max(8192),
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
          data: z.object({ providerID: z.string(), modelID: z.string() }).passthrough().nullable(),
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
