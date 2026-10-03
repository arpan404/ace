import type { Key } from "@ace/core";
import { number, object, type Data } from "./native.ts";
import type { ClaudeState } from "./state.ts";

interface Counts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}
interface Accounting {
  messages: Map<string, Counts>;
  total: Counts;
}
export type ChildUsage = Map<Key, Accounting>;
const zero = (): Counts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
/** SDK blocks repeat message usage; refinements replace that message's contribution. */
export function childUsage(state: ClaudeState, agent: Key, id: string, message: Data): void {
  if (!message["usage"]) return;
  const sample = object(message["usage"]);
  const occupied =
    number(sample["input_tokens"]) +
    number(sample["cache_read_input_tokens"]) +
    number(sample["cache_creation_input_tokens"]) +
    number(sample["output_tokens"]);
  if (
    typeof sample["input_tokens"] === "number" &&
    Number.isSafeInteger(sample["input_tokens"]) &&
    sample["input_tokens"] >= 0 &&
    Number.isSafeInteger(occupied) &&
    occupied >= 0
  )
    state.emit({
      type: "context.sample",
      agent,
      usedTokens: occupied,
      ...(typeof message["model"] === "string" ? { model: message["model"] } : {}),
    });
  if (agent === state.root) return;
  const usage = object(message["usage"]);
  const next = {
    inputTokens: number(usage["input_tokens"]),
    outputTokens: number(usage["output_tokens"]),
    cachedInputTokens: number(usage["cache_read_input_tokens"]),
  };
  const prior = state.childUsage.get(agent);
  const messages = prior?.messages ?? new Map<string, Counts>();
  const previous = messages.get(id) ?? zero();
  next.inputTokens = Math.max(next.inputTokens, previous.inputTokens);
  next.outputTokens = Math.max(next.outputTokens, previous.outputTokens);
  next.cachedInputTokens = Math.max(next.cachedInputTokens, previous.cachedInputTokens);
  const totals = prior?.total ?? zero();
  const total = {
    inputTokens: totals.inputTokens + next.inputTokens - previous.inputTokens,
    outputTokens: totals.outputTokens + next.outputTokens - previous.outputTokens,
    cachedInputTokens:
      totals.cachedInputTokens + next.cachedInputTokens - previous.cachedInputTokens,
  };
  messages.set(id, next);
  state.childUsage.set(agent, { messages, total });
  state.emit({ type: "usage", agent, ...total });
}
