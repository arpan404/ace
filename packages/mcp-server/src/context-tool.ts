import { z } from "zod";
import { McpStatus } from "@ace/protocol";
import { KnowledgeResult, KnowledgeTopic, type KnowledgePort } from "./knowledge-tools.ts";
import { ToolRegistry, nodeScheduler } from "./registry.ts";
import { mcpStatusGroups, type StatusReader } from "./status.ts";

/** `status` is this session; the rest are what the project already knows. */
export const ContextTopic = z.enum(["status", ...KnowledgeTopic.options]);
export type ContextTopic = z.infer<typeof ContextTopic>;
const ContextStatus = McpStatus.extend({
  project: z.object({ id: z.string(), name: z.string() }).optional(),
});
export const ContextResult = KnowledgeResult.extend({ status: ContextStatus.optional() });
export type ContextResult = z.infer<typeof ContextResult>;
const defaultTopics: ContextTopic[] = ["status", "recent", "changes", "prs", "notes"];

export const contextToolCatalog = [
  {
    name: "context",
    title: "Read project and session context",
    riskClass: "read-only",
    description:
      "Project and session context; call it first in an existing project. status: thread, access, ace groups off. recent: latest threads, outcomes. changes: branch, uncommitted paths. prs: linked PRs, CI. notes: project notes. diagnostics: your failed ace calls, what keeps this thread unsettled.",
    input: z.strictObject({
      topics: z.array(ContextTopic).min(1).max(ContextTopic.options.length).default(defaultTopics),
    }),
    output: ContextResult,
    // One open field per topic: the full shapes would cost context on every listing.
    advertisedOutput: z.looseObject(
      Object.fromEntries(ContextTopic.options.map((topic) => [topic, z.unknown().optional()])),
    ),
    capability: null,
    timeoutMs: 30_000,
  },
] as const;

/**
 * `context` lives in its own registry: session discovery is mandatory server metadata,
 * independent of the backend tools' admission limit, and works before any toolkit registers.
 */
export function createContextRegistry(
  registry: ToolRegistry,
  read: StatusReader = () => ({ access: null }),
  knowledge?: Pick<KnowledgePort, "context">,
) {
  const discovery = new ToolRegistry({
    scheduler: nodeScheduler,
    maxTools: 1,
    ...(registry.observeCall ? { observeCall: registry.observeCall } : {}),
  });
  discovery.register({
    ...contextToolCatalog[0],
    async run({ topics }, { caller, capabilities, signal }): Promise<ContextResult> {
      signal.throwIfAborted();
      const wanted = topics.filter((topic) => topic !== "status");
      const known =
        knowledge && wanted.length ? await knowledge.context(caller, wanted, signal) : {};
      if (!topics.includes("status")) return known;
      const state = read(caller);
      return {
        status: {
          threadId: caller.threadId,
          agentId: caller.agentId,
          access: state.access,
          ...(state.project ? { project: state.project } : {}),
          // Only what is off, with why: a group that is on needs no words.
          groups: mcpStatusGroups(
            registry.capabilities(),
            capabilities,
            state.disabled,
            state.offReasons,
          ).filter((group) => !group.enabled),
        },
        ...known,
      };
    },
  });
  return discovery;
}

/** Resources that are one `context` topic each. */
export const contextResources: readonly { uri: string; topic: ContextTopic; name: string }[] = [
  { uri: "ace://status", topic: "status", name: "ace status: access mode and tool groups" },
  { uri: "ace://project/recent", topic: "recent", name: "Recent threads in this project" },
  { uri: "ace://worktree/changes", topic: "changes", name: "This worktree's changes" },
  { uri: "ace://project/prs", topic: "prs", name: "Linked pull requests and CI" },
  { uri: "ace://project/notes", topic: "notes", name: "Project notes" },
  {
    uri: "ace://thread/self/diagnostics",
    topic: "diagnostics",
    name: "This session's diagnostics",
  },
];
