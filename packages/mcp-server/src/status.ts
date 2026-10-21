import { McpCapability, type McpAttribution, type McpStatus } from "@ace/protocol";

/** The guides the always-on guidance points to; each is a shipped skill and a `guide` topic. */
export const guideTopics = [
  "ace-agents",
  "ace-browser",
  "visualize",
  "ace-threads",
  "ace-computer-use",
] as const;
/** Every family a tool can belong to: the guides above and offshift, loaded only on request. */
export const toolFamilies = [...guideTopics, "offshift"] as const;

export type StatusReader = (caller: McpAttribution) => {
  access: McpStatus["access"];
  /** The caller's project, for `context` topic status. */
  project?: { id: string; name: string };
  /** False hides `ask`: the provider has its own ask tool and this is not a child thread. */
  askAvailable?: boolean;
  disabled?: Partial<Record<McpCapability, string>>;
};

/**
 * MCP server instructions: the always-on part of ace's guidance, kept under about 315 tokens.
 * Claude Code and Codex defer ace tools behind tool search, so this says when to reach for them
 * by naming the situation and the tool; the detail lives in the guides (`guide`, and native
 * skills where ace ships them). Tool names are bare: providers add the `ace` namespace.
 */
export function aceGuidance(groups?: readonly string[]): string {
  const has = (...names: string[]) => !groups || names.some((name) => groups.includes(name));
  return [
    "ace is the app running this session. Your shell, file and web tools work as usual; ace's tools do what only ace can. Use them when:",
    "- you start work in an existing project: context first;",
    has("agents")
      ? "- work splits into independent or parallel parts: delegate (instead of your provider's subagent tool), then wait;"
      : "",
    has("browser")
      ? "- you changed a UI or a localhost page: browser_open, then browser_snapshot; the person watches; console and network logs are there;"
      : "",
    "- visuals or images: guide visualize first;",
    "- after gh pr create or finding the PR: thread_link_pr;",
    has("thread_control")
      ? "- the person wants a separate thread in any project: thread_start; to settle a finished one, this one too: thread_control settle;"
      : "",
    has("screen", "devices") ? "- the person names a native app or simulator: screen_state;" : "",
    "Not sure which ace tool fits? tools_find with what you want to do.",
    `Each family's how-to and other tools: guide with topic ${guideTopics.join(", ")}; offshift loads Offshift, to own a coding outcome end to end.`,
    "If an ace tool says its group is off, tell the person. Agents never answer approvals.",
  ]
    .filter(Boolean)
    .join("\n");
}
/** The server's copy, for clients that read MCP server instructions: every group. */
export const aceInstructions = aceGuidance();

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
