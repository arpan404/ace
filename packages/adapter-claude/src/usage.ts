import type { Key } from "@ace/core";
import { number, object, type Data } from "./native.ts";
import type { ClaudeState } from "./state.ts";

interface Counts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
interface Accounting {
  id: string;
  latest: Counts;
  total: Counts;
}
export type ChildUsage = Map<Key, Accounting>;
const zero = (): Counts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
/** SDK blocks repeat message usage; refinements replace that message's contribution. */
export function childUsage(state: ClaudeState, agent: Key, id: string, message: Data): void {
  if (agent === state.root || !message["usage"]) return;
  const usage = object(message["usage"]);
  const next = {
    inputTokens: number(usage["input_tokens"]),
    outputTokens: number(usage["output_tokens"]),
    cachedInputTokens: number(usage["cache_read_input_tokens"]),
  };
  const prior = state.childUsage.get(agent);
  const previous = prior?.id === id ? prior.latest : zero();
  const totals = prior?.total ?? zero();
  const total = {
    inputTokens: totals.inputTokens + next.inputTokens - previous.inputTokens,
    outputTokens: totals.outputTokens + next.outputTokens - previous.outputTokens,
    cachedInputTokens:
      totals.cachedInputTokens + next.cachedInputTokens - previous.cachedInputTokens,
  };
  state.childUsage.set(agent, { id, latest: next, total });
  state.emit({ type: "usage", agent, ...total });
}
