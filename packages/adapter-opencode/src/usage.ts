import { z } from "zod";
import type { Fact } from "@ace/core";
import { type Data } from "./data.ts";
import type { NativeState } from "./native-state.ts";

const ModelRef = z.object({
  providerID: z.string().min(1).max(256),
  id: z.string().min(1).max(256),
});
export function qualifiedModel(value: unknown): string | undefined {
  const parsed = ModelRef.safeParse(value);
  if (!parsed.success) return undefined;
  const qualified = `${parsed.data.providerID}/${parsed.data.id}`;
  return qualified.length <= 256 ? qualified : undefined;
}
export function selectModel(state: NativeState, session: string, value: unknown): Fact[] {
  const model = qualifiedModel(value),
    metadata = state.agents.get(session);
  if (!model || !metadata) return [];
  metadata.model = model;
  return [{ type: "agent.linked", agent: state.key(session), model }];
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Tokens = z
  .object({
    input: count,
    output: count,
    reasoning: count.optional(),
    cache: z.object({ read: count, write: count }).optional(),
  })
  .passthrough();
function counts(value: unknown) {
  const parsed = Tokens.safeParse(value);
  if (!parsed.success) return undefined;
  const t = parsed.data;
  const inputTokens = t.input + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
  const outputTokens = t.output + (t.reasoning ?? 0);
  if (!Number.isSafeInteger(inputTokens + outputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: t.cache?.read ?? 0,
    cacheWriteTokens: t.cache?.write ?? 0,
    reasoningTokens: t.reasoning ?? 0,
  };
}
/** Session billing is cumulative; step occupancy replaces the last sampling. */
export function sessionUsage(state: NativeState, session: string, data: Data): Fact[] {
  const tokens = counts(data.tokens);
  if (!tokens) return [];
  const model = qualifiedModel(data.model) ?? state.agents.get(session)?.model;
  const cost = z.number().nonnegative().safeParse(data.cost);
  return [
    {
      type: "usage",
      agent: state.key(session),
      ...tokens,
      counterMode: "cumulative",
      counterKey: `session:${session}`,
      ...(model ? { model } : {}),
      ...(cost.success ? { costUsd: cost.data } : {}),
    },
  ];
}
export function stepContext(state: NativeState, session: string, data: Data): Fact[] {
  const tokens = counts(data.tokens);
  if (!tokens) return [];
  const model = qualifiedModel(data.model) ?? state.agents.get(session)?.model;
  return [
    {
      type: "context.sample",
      agent: state.key(session),
      usedTokens: tokens.inputTokens + tokens.outputTokens,
      sessionId: session,
      ...(model ? { model } : {}),
    },
  ];
}
