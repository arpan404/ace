import { McpCapability, type McpAttribution, type McpStatus } from "@ace/protocol";
import { statusToolCatalog } from "./catalog.ts";
import { ToolRegistry, nodeScheduler } from "./registry.ts";

/** The guides the always-on guidance points to; each is a shipped skill and an ace_guide topic. */
export const guideTopics = [
  "ace-agents",
  "ace-browser",
  "visualize",
  "ace-threads",
  "ace-computer-use",
] as const;

export type StatusReader = (caller: McpAttribution) => {
  access: McpStatus["access"];
  /** False hides ace_ask: the provider has its own ask tool and this is not a child thread. */
  askAvailable?: boolean;
  disabled?: Partial<Record<McpCapability, string>>;
};

/**
 * MCP server instructions: the always-on part of ace's guidance, kept under about 300 tokens.
 * Claude Code and Codex defer ace tools behind tool search, so this says first when to look for
 * them; the detail lives in the guides (`ace_guide`, and native skills where ace ships them).
 * ace adds to the agent's own tools and never stands in for them.
 */
export function aceGuidance(groups?: readonly string[]): string {
  const has = (...names: string[]) => !groups || names.some((name) => groups.includes(name));
  return [
    "ace is the app running this session. Its tools add ace features beside your own; your shell, file, web and other tools work as usual. Look for ace tools (ace_*, browser_*, screen_*, sim_*, delegate_task) when a task needs:",
    has("agents")
      ? "- other agents or providers working in parallel: delegate_task (not your provider's native subagent tool), then ace_wait;"
      : "",
    has("browser")
      ? "- a page the person can watch in ace's browser, localhost included, with console and network: browser_open;"
      : "",
    "- a chart, diagram or mockup shown inline: ace_html_render;",
    "- this project's recent work, changes, PRs and notes: ace_context; link a PR you opened: ace_thread_link_pr;",
    has("screen", "devices")
      ? "- a native app or simulator the person names: screen_open_app, or ace_guide ace-computer-use."
      : "",
    `How-to for each, plus the rest of its tools: ace_guide with topic ${guideTopics.join(", ")}.`,
    "If an ace tool reports disabled or denied, tell the person. Agents never resolve approvals.",
  ]
    .filter(Boolean)
    .join("\n");
}
/** The server's copy, for clients that read MCP server instructions: every group. */
export const aceInstructions = aceGuidance();

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
        groups: mcpStatusGroups(registered, capabilities, state.disabled),
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
): McpStatus["groups"] {
  return [
    { name: "thread", enabled: true },
    ...McpCapability.options.map((name) => {
      const reason =
        disabled?.[name] ??
        (!registered.has(name) ? "This ace daemon is not running this tool group." : undefined) ??
        (!capabilities.includes(name)
          ? "ace does not offer this tool group to this provider session."
          : undefined);
      return reason === undefined ? { name, enabled: true } : { name, enabled: false, reason };
    }),
  ];
}
