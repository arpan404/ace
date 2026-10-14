import type { ProviderAdapter } from "@ace/engine-api";
import { codexCapabilities } from "./capabilities.ts";
import { createCodexTranslator } from "./translator.ts";
import { openCodexSession, type CodexOptions } from "./session.ts";
import { CodexHostPool } from "./host-pool.ts";
export { createCodexTranslator } from "./translator.ts";
export { codexCapabilities } from "./capabilities.ts";
export type { CodexSessionContext } from "./session-context.ts";
export type { CodexOptions } from "./session.ts";
export { CodexHostPool, defaultHostIdleMs } from "./host-pool.ts";
/** Sessions from one adapter share app-servers per account; Codex hosts many threads per process. */
export function createCodexAdapter(options: CodexOptions = {}): ProviderAdapter {
  const shared = { ...options, hosts: options.hosts ?? new CodexHostPool() };
  return {
    provider: "codex",
    capabilities: codexCapabilities,
    createTranslator: createCodexTranslator,
    openSession: (ctx) => openCodexSession(ctx, shared),
  };
}
export const adapter = createCodexAdapter();
export default adapter;

export { CodexInteractionUnavailable } from "./interaction-lifecycle.ts";

export { CodexExitDiagnostic } from "./exit-diagnostic.ts";
