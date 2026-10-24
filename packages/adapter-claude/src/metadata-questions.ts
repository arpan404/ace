import type { Query } from "@anthropic-ai/claude-agent-sdk";

/** The SDK query's experimental usage read, when this SDK has it. */
export type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
    skipBehaviors?: boolean;
  }) => Promise<unknown>;
};

/** Plan limits through the experimental `get_usage` read; undefined when this SDK lacks it. */
export function askUsage(query: UsageQuery): Promise<unknown> {
  const read = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  return typeof read === "function"
    ? read.call(query, { skipBehaviors: true })
    : Promise.resolve(undefined);
}

/** Questions an initialization-only query can answer, by the name a metadata host is asked. */
export const metadataQuestions = {
  models: { what: "model discovery", ask: (query: Query) => query.supportedModels() },
  usage: { what: "usage read", ask: (query: Query) => askUsage(query) },
} as const;
export type MetadataQuestion = keyof typeof metadataQuestions;
