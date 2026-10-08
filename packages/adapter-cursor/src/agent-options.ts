import type { AgentOptions, LocalAgentStore } from "@cursor/sdk";
import { cursorSdkInjection } from "@ace/mcp-server";
import type { OpenOptions } from "./contracts.ts";
import { localPolicy, cursorRestrictedTools } from "./policy.ts";

function defaults(options: OpenOptions, store: LocalAgentStore, guidanceDirectory?: string) {
  return {
    local: { cwd: options.cwd, store, ...(guidanceDirectory ? { dirs: [guidanceDirectory] } : {}) },
    model: { id: options.model ?? "composer-2.5" },
  };
}

/** The admitted options also key SDK prewarming, including scoped MCP definitions. */
export function sandboxCursorOptions(
  options: OpenOptions,
  store: LocalAgentStore,
  guidanceDirectory?: string,
): AgentOptions {
  const base = defaults(options, store, guidanceDirectory);
  const injection = options.mcp && !options.readOnly ? cursorSdkInjection(options.mcp) : undefined;
  return {
    ...base,
    local: { ...base.local, ...localPolicy("restricted", true) },
    ...(options.readOnly ? cursorRestrictedTools("restricted", false) : {}),
    ...(injection ? { mcpServers: injection.mcpServers } : {}),
  };
}

export function limitedCursorOptions(
  options: OpenOptions,
  store: LocalAgentStore,
  guidanceDirectory?: string,
): AgentOptions {
  const base = defaults(options, store, guidanceDirectory);
  return {
    ...base,
    local: { ...base.local, ...localPolicy("restricted", false) },
    ...cursorRestrictedTools("restricted", false),
  };
}

export function fullCursorOptions(
  options: OpenOptions,
  store: LocalAgentStore,
  guidanceDirectory?: string,
): AgentOptions {
  const base = defaults(options, store, guidanceDirectory);
  const injection = options.mcp ? cursorSdkInjection(options.mcp) : undefined;
  return {
    ...base,
    local: { ...base.local, ...localPolicy("full-access", false) },
    ...(injection ? { mcpServers: injection.mcpServers } : {}),
  };
}
