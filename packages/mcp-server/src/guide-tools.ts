import { z } from "zod";
import type { Toolkit } from "./toolkits.ts";
import { coreTools, toolsetOf } from "./toolsets.ts";

/** One on-demand guide: a shipped ace skill, read whole only when a task needs it. */
export interface AceGuide {
  /** The skill name, which is also the `ace_guide` topic. */
  readonly name: string;
  /** The skill's one-line trigger. */
  readonly description: string;
  /** The skill body, without its frontmatter. */
  readonly body: string;
}

const GuideResult = z.strictObject({
  topic: z.string().min(1).max(64),
  guide: z.string().min(1).max(65_536),
  /** The topic's tools beyond the core ones; reading the guide adds them to the tool list. */
  tools: z.array(z.string().min(1).max(128)).max(128),
});

/**
 * `ace_guide` serves the shipped skills to every provider, including those ace can't give
 * native skills (OpenCode, Cursor, Pi, ACP). Claude Code and Codex also receive them as native
 * skills; this tool returns the same text, so the always-on guidance stays short everywhere.
 */
export function guideToolkit(guides: readonly AceGuide[]): Toolkit {
  return {
    register(registry) {
      const [first, ...rest] = guides.map((guide) => guide.name);
      if (!first) return;
      const byName = new Map(guides.map((guide) => [guide.name, guide]));
      registry.register({
        name: "ace_guide",
        riskClass: "read-only",
        description: `Read ace's how-to for a task; it also adds the topic's other ace tools to your list. Topics: ${[first, ...rest].join(", ")}.`,
        input: z.strictObject({ topic: z.enum([first, ...rest]) }),
        output: GuideResult,
        capability: null,
        timeoutMs: 10_000,
        async run({ topic }, { signal }) {
          signal.throwIfAborted();
          const guide = byName.get(topic);
          if (!guide) throw new Error("Guide missing");
          const tools = registry
            .names()
            .filter((name) => toolsetOf(name) === topic && !coreTools.has(name));
          return { topic, guide: guide.body, tools };
        },
      });
    },
  };
}
