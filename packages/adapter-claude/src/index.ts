import type { ProviderAdapter } from "@ace/engine-api";
import { forkClaudeSession } from "./fork.ts";
import { capabilities } from "./capabilities.ts";
import { createTranslator } from "./translator.ts";
import { openSession, type ClaudeOptions } from "./session.ts";
import { CliVersions } from "./cli-versions.ts";
export { createTranslator } from "./translator.ts";
export { capabilities } from "./capabilities.ts";
export type { ClaudeOptions } from "./session.ts";
export function createClaudeAdapter(options: ClaudeOptions = {}): ProviderAdapter {
  // One adapter reads each installed CLI's version once, until that file changes.
  const versions = new CliVersions();
  // Windows names the person's home USERPROFILE and usually leaves HOME unset. Forks clone
  // under it; sessions keep the environment they were given.
  if (process.platform === "win32" && !options.env?.HOME && options.env?.USERPROFILE) {
    const profile = { ...options, env: { ...options.env, HOME: options.env.USERPROFILE } };
    return {
      ...createClaudeAdapter(profile),
      openSession: (ctx) => openSession(ctx, options, versions),
    };
  }
  return {
    provider: "claude",
    capabilities,
    createTranslator,
    openSession: (ctx) => openSession(ctx, options, versions),
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
