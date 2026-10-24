import type { MetadataQueryInput } from "./metadata-query.ts";
import { askClaudeMetadata } from "./metadata-host-client.ts";

/** Initialization-only query. The host supplies the discovered CLI, its home and cancellation. */
export async function discoverClaudeModels(input: MetadataQueryInput): Promise<unknown> {
  const models = await askClaudeMetadata(input, "models");
  return { models };
}
