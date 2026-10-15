import type { AgentOptions, LocalAgentStore } from "@cursor/sdk";
import { cursorSdkInjection } from "@ace/mcp-server";
import { CursorPermissionOptions } from "@ace/provider-kit/permission-modes";
import type { OpenOptions } from "./contracts.ts";
export function nativeCursorOptions(
  options: OpenOptions,
  store: LocalAgentStore,
  guidanceDirectory?: string,
): AgentOptions {
  const permissions = options.permissionMode
    ? CursorPermissionOptions.parse(JSON.parse(options.permissionMode))
    : {};
  const injection = options.mcp ? cursorSdkInjection(options.mcp) : undefined;
  return {
    local: {
      cwd: options.cwd,
      // The SDK loads no ambient layer by default: no project or user rules, skills, hooks,
      // plugins or MCP servers, not even ace's own rule in `dirs`. Cursor keeps all of its own.
      settingSources: ["all"],
      store,
      ...permissions,
      enableAgentRetries: false,
      ...(guidanceDirectory ? { dirs: [guidanceDirectory] } : {}),
    },
    model: {
      id: options.model ?? "composer-2.5",
      ...(options.modelParams?.length ? { params: options.modelParams } : {}),
    },
    ...(injection ? { mcpServers: injection.mcpServers } : {}),
  };
}
