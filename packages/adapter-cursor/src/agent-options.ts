import type { AgentOptions, LocalAgentStore } from "@cursor/sdk";
import { cursorSdkInjection } from "@ace/mcp-server";
import { CursorPermissionOptions } from "@ace/provider-kit/permission-modes";
import type { OpenOptions } from "./contracts.ts";
export function nativeCursorOptions(options: OpenOptions, store: LocalAgentStore): AgentOptions {
  const permissions = options.permissionMode
    ? CursorPermissionOptions.parse(JSON.parse(options.permissionMode))
    : {};
  const injection = options.mcp ? cursorSdkInjection(options.mcp) : undefined;
  return {
    local: { cwd: options.cwd, store, ...permissions, enableAgentRetries: false },
    model: { id: options.model ?? "composer-2.5" },
    ...(injection ? { mcpServers: injection.mcpServers } : {}),
  };
}
