import { McpCapability, type McpAttribution, type McpStatus } from "@ace/protocol";
import { statusToolCatalog } from "./catalog.ts";
import { ToolRegistry, nodeScheduler } from "./registry.ts";

export type StatusReader = (caller: McpAttribution) => {
  access: McpStatus["access"];
  /** False hides ace_ask: the provider has its own ask tool and this is not a child thread. */
  askAvailable?: boolean;
  disabled?: Partial<Record<McpCapability, string>>;
  /** Whether this caller has a current app grant. False stages computer use discovery. */
  screenApproved?: boolean;
};

/**
 * MCP server instructions. Claude Code reads only the first 2,048 characters and defers ace tools
 * behind tool search, so this says first when to look for ace tools and by which names.
 */
export const aceInstructions = [
  "ace is the app running this session. Its tools act on ace itself, beside your own tools. Search for ace tools (names start with ace_, screen_ or device_, plus delegate_task) when you need to:",
  "- hand work to another agent or provider and collect the results: delegate_task, then ace_wait;",
  "- open, test or debug any website or localhost page in ace's browser: ace_browser_open, ace_browser_snapshot, ace_browser_logs;",
  "- show a chart, diagram, comparison or mockup inline: ace_html_render;",
  "- read or retitle this thread, or find other threads in this project: ace_thread_read, ace_thread_rename, ace_threads_list;",
  "- link a pull request you opened or found for this work: ace_thread_link_pr;",
  "- see what this project already knows (recent threads and outcomes, uncommitted changes, PRs and CI, notes, failed ace calls) before git or gh: ace_context; save a lasting project fact for every future thread: ace_note_add;",
  "- operate a native desktop app the person named: screen_* (computer use).",
  "ace has no file or shell tools. Read, create and edit files and run shell commands with your own workspace tools: no ace tool group, enabled or not, limits them.",
  "If an ace tool reports disabled, denied, read-only or human control, stop that ace action and tell the person; don't work around it with other ace tools. Agents never resolve approvals. ace_status lists the enabled ace groups.",
].join("\n");

export function createStatusRegistry(
  registry: ToolRegistry,
  read: StatusReader = () => ({ access: null }),
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
        access: state.access,
        groups: mcpStatusGroups(registered, capabilities, state.disabled, state.access),
      };
    },
  });
  return status;
}

/** Shared discovery policy for MCP clients and the person's Sources list. */
export function mcpStatusGroups(
  registered: ReadonlySet<McpCapability>,
  capabilities: readonly McpCapability[],
  disabled?: Partial<Record<McpCapability, string>>,
  access?: McpStatus["access"],
): McpStatus["groups"] {
  return [
    { name: "thread", enabled: true },
    ...McpCapability.options.map((name) => {
      const reason =
        disabled?.[name] ??
        (access === "read-only" && (name === "screen" || name === "devices")
          ? "Read-only mode refuses this tool group."
          : undefined) ??
        (!registered.has(name) ? "This ace daemon is not running this tool group." : undefined) ??
        (!capabilities.includes(name)
          ? "ace does not offer this tool group to this provider session."
          : undefined);
      return reason === undefined ? { name, enabled: true } : { name, enabled: false, reason };
    }),
  ];
}
