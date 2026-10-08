import { McpCapability, type McpAttribution, type McpStatus } from "@ace/protocol";
import { statusToolCatalog } from "./catalog.ts";
import { ToolRegistry, nodeScheduler } from "./registry.ts";

export type StatusReader = (caller: McpAttribution) => {
  permissionMode: McpStatus["permissionMode"];
  disabled?: Partial<Record<McpCapability, string>>;
  /** Whether this caller has a current app grant. False stages computer use discovery. */
  screenApproved?: boolean;
};

export const aceInstructions =
  "ace tools for this thread. Websites and web apps, including localhost: ace_browser_*. screen_* (computer use) only for a native desktop app the person asked you to operate. Call ace_status for what is enabled.";

export function createStatusRegistry(
  registry: ToolRegistry,
  read: StatusReader = () => ({ permissionMode: null }),
) {
  // Discovery is mandatory server metadata, independent of the backend tool admission limit.
  const status = new ToolRegistry({ scheduler: nodeScheduler, maxTools: 1 });
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
              (state.permissionMode === "read-only" && (name === "screen" || name === "devices")
                ? "Read-only mode refuses this tool group."
                : undefined) ??
              (!registered.has(name)
                ? "No backend is configured for this tool group."
                : undefined) ??
              (!capabilities.includes(name)
                ? "This provider session has no permission for this tool group."
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
