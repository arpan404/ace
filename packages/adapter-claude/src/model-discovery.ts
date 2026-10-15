import { askClaude, type MetadataQueryInput } from "./metadata-query.ts";

/** Initialization-only query. The host supplies the discovered CLI, its home and cancellation. */
export async function discoverClaudeModels(input: MetadataQueryInput): Promise<unknown> {
  const models = await askClaude(input, "model discovery", (query) => query.supportedModels());
  return { models };
}
