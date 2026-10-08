import { McpCapability, type McpAttribution, type McpStatus } from "@ace/protocol";
import { statusToolCatalog } from "./catalog.ts";
import { ToolRegistry, nodeScheduler } from "./registry.ts";

export type StatusReader = (caller: McpAttribution) => {
  permissionMode: McpStatus["permissionMode"];
  disabled?: Partial<Record<McpCapability, string>>;
};

export const aceInstructions =
  "ace is the local coding environment coordinating your thread and agent tree through the person's installed provider CLIs. Its tools are prefixed ace_; screen_ and device_ aliases and delegate_task are also ace tools. Groups include thread and agents, notifications, browser, screen/computer use, devices, projects, automations, files, preview, terminal and forge. Some groups may be disabled by the person or unavailable on this connection. To check whether ace is available, read ace://status or call ace_status for current availability and permission mode. OpenCode prefixes MCP tools with the server name, so its direct tool is ace_ace_status; Claude uses mcp__ace__ace_status. Use the exact advertised name. A disabled group does not mean ace MCP is absent. Ask the person to enable disabled features; tools cannot grant themselves access.";

export function createStatusRegistry(
  registry: ToolRegistry,
  read: StatusReader = () => ({ permissionMode: null }),
) {
  // Discovery is mandatory server metadata, independent of the backend tool admission limit.
  const status = new ToolRegistry({
    scheduler: nodeScheduler,
    maxTools: 1,
    ...(registry.observeCall ? { observeCall: registry.observeCall } : {}),
  });
  status.register({
    ...statusToolCatalog[0],
    async run(_, { caller, capabilities, signal }): Promise<McpStatus> {
      signal.throwIfAborted();
      const state = read(caller);
      const registered = registry.capabilities();
      return {
        threadId: caller.threadId,
        agentId: caller.agentId,
        permissionMode: state.permissionMode,
        groups: [
          { name: "thread", enabled: true },
          ...McpCapability.options.map((name) => {
            const reason =
              state.disabled?.[name] ??
              (!registered.has(name)
                ? "No backend is configured for this tool group. Ask the person to configure this feature in ace."
                : undefined) ??
              (!capabilities.includes(name)
                ? "This provider session has no permission for this tool group. Ask the person to start a session with this group enabled."
                : undefined);
            return reason === undefined
              ? { name, enabled: true }
              : { name, enabled: false, reason };
          }),
          {
            name: "files",
            enabled: false,
            reason:
              "Files are available through the provider's workspace tools and ace's file client; there is no standalone ace MCP files group.",
          },
        ],
      };
    },
  });
  return status;
}
