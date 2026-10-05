import { OpenCodeServer, type ServerOptions } from "./server.ts";
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
  try {
    signal.throwIfAborted();
    await server.ready(signal);
    signal.throwIfAborted();
    const client = server.scoped(directory, () => {}, signal);
    const payload: unknown = await client.model.list({ location: { directory } }, { signal });
    const validated = z
      .object({
        location: z.object({ directory: z.literal(directory) }),
        data: z.array(z.unknown()).max(8192),
      })
      .passthrough()
      .parse(payload);
    return server.redact(validated);
  } catch {
    throw new Error(
      signal.aborted ? "OpenCode model discovery cancelled" : "OpenCode model discovery failed",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    await server.close();
  }
}
