import type { ProviderAdapter } from "@ace/engine-api";
import { capabilities } from "./capabilities.ts";
import { createTranslator } from "./translator.ts";
import { openSession, type ClaudeOptions } from "./session.ts";
export { createTranslator } from "./translator.ts";
export { capabilities } from "./capabilities.ts";
export type { ClaudeOptions } from "./session.ts";
export function createClaudeAdapter(options: ClaudeOptions = {}): ProviderAdapter {
  return {
    provider: "claude",
    capabilities,
    createTranslator,
    openSession: (ctx) => openSession(ctx, options),
  };
}
export const adapter = createClaudeAdapter();
export default adapter;
