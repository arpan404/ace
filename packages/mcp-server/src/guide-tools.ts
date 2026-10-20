import { z } from "zod";
import type { Toolkit } from "./toolkits.ts";
import { coreTools } from "./toolsets.ts";
import { bareToolName } from "./tool-names.ts";
import { guideDelivery } from "./tool-delivery.ts";

/** One on-demand guide: a shipped ace skill, read whole only when a task needs it. */
export interface AceGuide {
  /** The skill name, which is also the `guide` topic. */
  readonly name: string;
  /** The skill's one-line trigger. */
  readonly description: string;
  /** The skill body, without its frontmatter. */
  readonly body: string;
}

const InlineTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
const GuideResult = z.strictObject({
  topic: z.string().min(1).max(64),
  guide: z.string().min(1).max(65_536),
  /** The topic's tools beyond the core ones, by the names to call. */
  tools: z.array(z.string().min(1).max(128)).max(128),
  /** Clients that do not list every tool: their schemas, so the next call needs no lookup. */
  schemas: z.array(InlineTool).max(128).optional(),
  /** How to call them, where that is not by name. */
  how: z.string().max(256).optional(),
});

/**
 * `guide` serves the shipped skills to every provider, including those ace can't give native
 * skills (OpenCode, Cursor, Pi, ACP). Claude Code and Codex also receive them as native skills;
 * this tool returns the same text, so the always-on guidance stays short everywhere. Reading a
 * guide also adds its family's tools to a core-mode session's list, and returns their schemas
 * inline there, so the agent can call them in the same turn its client reloads the list.
 */
export function guideToolkit(guides: readonly AceGuide[]): Toolkit {
  return {
    register(registry) {
      const [first, ...rest] = guides.map((guide) => guide.name);
      if (!first) return;
      const byName = new Map(guides.map((guide) => [guide.name, guide]));
      registry.register({
        name: "guide",
        title: "Read an ace guide",
        riskClass: "read-only",
        description: `Read ace's how-to for a task and get the names of that task's other ace tools (also added to your tool list). Topics: ${[first, ...rest].join(", ")}.`,
        input: z.strictObject({
          topic: z.enum([first, ...rest]).describe("The guide to read, by its topic name."),
        }),
        output: GuideResult,
        capability: null,
        timeoutMs: 10_000,
        async run({ topic }, context) {
          context.signal.throwIfAborted();
          const guide = byName.get(topic);
          if (!guide) throw new Error("Guide missing");
          const family = registry
            .describe(topic, context)
            .filter((tool) => !coreTools.has(bareToolName(tool.name)));
          const delivery = guideDelivery(context.listing, context.client);
          return {
            topic,
            guide: guide.body,
            tools: family.map((tool) => tool.name),
            ...(delivery.how ? { how: delivery.how } : {}),
            ...(delivery.schemas
              ? {
                  schemas: family.map(({ name, description, inputSchema }) =>
                    description === undefined
                      ? { name, inputSchema }
                      : { name, description, inputSchema },
                  ),
                }
              : {}),
          };
        },
      });
    },
  };
}
