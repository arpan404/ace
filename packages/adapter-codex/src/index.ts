import type { ProviderAdapter } from "@ace/engine-api";
import { codexCapabilities } from "./capabilities.ts";
import { createCodexTranslator } from "./translator.ts";
import { openCodexSession, type CodexOptions } from "./session.ts";
export { createCodexTranslator } from "./translator.ts";
export { codexCapabilities } from "./capabilities.ts";
export type { CodexSessionContext } from "./session-context.ts";
export type { CodexOptions } from "./session.ts";
export function createCodexAdapter(options: CodexOptions = {}): ProviderAdapter {
  return {
    provider: "codex",
    capabilities: codexCapabilities,
    createTranslator: createCodexTranslator,
    openSession: (ctx) => openCodexSession(ctx, options),
  };
}
export const adapter = createCodexAdapter();
export default adapter;

export { CodexInteractionUnavailable } from "./interaction-lifecycle.ts";
