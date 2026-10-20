import { z } from "zod";
import { nodeScheduler, ToolRegistry, type CatalogTool } from "./registry.ts";
import { PublicToolError } from "./public-error.ts";
import { maxBatchInputBytes } from "./result-budgets.ts";
import { maxToolTimeoutMs } from "./timeouts.ts";
import { guideTopics } from "./status.ts";
import { rankTools } from "./tool-search.ts";
import { findDelivery } from "./tool-delivery.ts";
import { aceToolDispatch, aceToolSearch, bareToolName } from "./tool-names.ts";

const maxMatches = 10;
const Match = z.strictObject({
  /** The name to call, or to pass to tools_call. */
  name: z.string(),
  title: z.string().optional(),
  /** The description's first sentence. */
  purpose: z.string(),
  family: z.string().optional(),
  effect: z.enum(["read-only", "changes", "destructive"]),
  /** Absent where the session's own tool list carries it (`tool-delivery.ts`). */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
const FindResult = z.strictObject({
  matches: z.array(Match).max(maxMatches),
  /** How to call the matches in this session. */
  how: z.string().optional(),
  /** Where to look when nothing matched. */
  hint: z.string().optional(),
});
type Match = z.infer<typeof Match>;

/** What a tool's annotations say it does, in one word. */
function effect({ tool }: CatalogTool): Match["effect"] {
  if (tool.annotations?.destructiveHint === true) return "destructive";
  return tool.annotations?.readOnlyHint === true ? "read-only" : "changes";
}
function purpose(description: string | undefined): string {
  const first = (description ?? "").split(/(?<=[.!?])\s/)[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** The families a `tools_find` result returned, for a core-mode session to open. */
export function foundFamilies(result: unknown): string[] {
  const parsed = z
    .object({ matches: z.array(z.object({ family: z.string().optional() })) })
    .safeParse(result);
  return parsed.success
    ? [...new Set(parsed.data.matches.flatMap((match) => (match.family ? [match.family] : [])))]
    : [];
}

const toolsFind = {
  name: aceToolSearch,
  title: "Find ace tools",
  riskClass: "read-only",
  openWorld: false,
  description:
    "Find the ace tools for what you want to do, among the ones this session can call. Returns each match's name, purpose, effect and input schema.",
  input: z.strictObject({
    query: z
      .string()
      .min(1)
      .max(500)
      .describe('What you want to do, in plain words, e.g. "click a button in Safari".'),
    limit: z.number().int().min(1).max(maxMatches).default(5).describe("At most this many."),
    family: z.enum(guideTopics).optional().describe("Only this family's tools."),
  }),
  output: FindResult,
  capability: null,
  timeoutMs: 10_000,
} as const;
const toolsCall = {
  name: aceToolDispatch,
  title: "Call an ace tool",
  // Annotations are per tool and this one can reach destructive tools, so it says so: a
  // client that gates destructive tools asks before every dispatched call (ADR 0082).
  riskClass: "external-effect",
  destructive: true,
  description:
    "Run any ace tool by name, with the arguments its schema takes (from tools_find or guide). Returns that tool's result.",
  input: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (name) => ![aceToolSearch, aceToolDispatch].includes(bareToolName(name)),
        "an ace tool other than tools_find or tools_call",
      )
      .meta({ "x-ace-constraint": "Not tools_find or tools_call." })
      .describe("The tool's name, as tools_find returns it."),
    arguments: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("The tool's own arguments, matching its input schema."),
  }),
  /** Documentation only: the result is the dispatched tool's own, unchanged. */
  output: z.looseObject({ content: z.array(z.unknown()), isError: z.boolean().optional() }),
  capability: null,
  // The dispatched tool keeps its own input and time limits; these only have to admit them.
  maxInputBytes: maxBatchInputBytes + 1024,
  timeoutMs: maxToolTimeoutMs,
} as const;
/** The meta tools' definitions, for documentation and static approval attribution. */
export const metaToolCatalog = [toolsFind, toolsCall] as const;

/**
 * `tools_find` and `tools_call`: the way to the rest of ace's tools for a session that does not
 * list them all. They live in their own registry because they act on the session's whole
 * catalogue, which the server lends them per call (`SessionTools`).
 */
export function createMetaRegistry(): ToolRegistry {
  const registry = new ToolRegistry({ scheduler: nodeScheduler, maxTools: 2 });
  registry.register({
    ...toolsFind,
    advertisedOutput: z.looseObject({ matches: z.array(z.looseObject({ name: z.string() })) }),
    async run({ query, limit, family }, context) {
      context.signal.throwIfAborted();
      const session = context.session;
      if (!session) throw new PublicToolError("tool_unavailable");
      const entries = session.catalog().map((entry) => ({
        entry,
        name: entry.tool.name,
        title: entry.tool.title,
        description: entry.tool.description,
        family: entry.family,
        inputSchema: entry.tool.inputSchema,
      }));
      const delivery = findDelivery(session.listing, context.client);
      const matches = rankTools(query, entries, { limit, family }).map((found) => {
        const match: Match = {
          name: found.name,
          purpose: purpose(found.description),
          effect: effect(found.entry),
        };
        if (delivery.schemas) match.inputSchema = found.inputSchema;
        if (found.title) match.title = found.title;
        if (found.family) match.family = found.family;
        return match;
      });
      if (!matches.length)
        return {
          matches,
          hint: `No ace tool here matched. Try other words, a family (${guideTopics.join(", ")}), or guide with one of those topics. A tool whose group is off is not offered; context with topics [status] lists the groups.`,
        };
      return { matches, ...(delivery.how ? { how: delivery.how } : {}) };
    },
  });
  const { output: _documented, ...dispatcher } = toolsCall;
  registry.registerContent({
    ...dispatcher,
    async run({ name, arguments: args }, context) {
      const dispatch = context.session?.dispatch;
      if (!dispatch) throw new PublicToolError("tool_unavailable");
      return dispatch(name, args, context.signal);
    },
  });
  return registry;
}
