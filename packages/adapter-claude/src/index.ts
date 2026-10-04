import type { ProviderAdapter } from "@ace/engine-api";
import { forkClaudeSession } from "./fork.ts";
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
    ...(options.env?.HOME
      ? {
          forkSession: (input: { nativeSessionId: string; signal: AbortSignal }) =>
            forkClaudeSession({
              ...input,
              home: options.env?.HOME ?? "",
              ...(options.env?.CLAUDE_CONFIG_DIR
                ? { configDir: options.env.CLAUDE_CONFIG_DIR }
                : {}),
            }),
        }
      : {}),
  };
}
export const adapter = createClaudeAdapter();
export default adapter;

export {
  codingConfiguration,
  isolatedConfiguration,
  ClaudeConfiguration,
} from "./configuration.ts";
export { spawnSdkProcess } from "./sdk-process.ts";
export { discoverClaudeModels } from "./model-discovery.ts";
export { forkClaudeSession } from "./fork.ts";
export type { ClaudeMcpServers } from "./mcp-controls.ts";
export { ClaudeRateLimitObservation } from "./rate-limits.ts";

export { content as claudeInputContent } from "./input.ts";
