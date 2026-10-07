import type { Key } from "@ace/core";
import { object, type Data } from "./native.ts";
import { tokenCounts, zeroCounts, type TokenCounts } from "./token-counts.ts";
import type { ClaudeState } from "./state.ts";

type Counts = TokenCounts;
interface Accounting {
  messages: Map<string, Counts>;
  total: Counts;
}
export type ChildUsage = Map<Key, Accounting>;
const zero = zeroCounts;
/** SDK blocks repeat message usage; refinements replace that message's contribution. */
export function childUsage(state: ClaudeState, agent: Key, id: string, message: Data): void {
  if (!message["usage"]) return;
  const sample = object(message["usage"]);
  const next = tokenCounts(message["usage"]);
  if (!next) return;
  const occupied = next.inputTokens + next.outputTokens;
  if (
    typeof sample["input_tokens"] === "number" &&
    Number.isSafeInteger(sample["input_tokens"]) &&
    sample["input_tokens"] >= 0 &&
    Number.isSafeInteger(occupied)
  )
    state.emit({
      type: "context.sample",
      agent,
      usedTokens: occupied,
      ...(typeof message["model"] === "string" ? { model: message["model"] } : {}),
    });
  if (agent === state.root) return;
  const prior = state.childUsage.get(agent);
  if (
    (!prior && state.childUsage.size >= 256) ||
    (prior && !prior.messages.has(id) && prior.messages.size >= 1024)
  ) {
    if (!state.childUsageOverflow) {
      state.childUsageOverflow = true;
      state.notice(
        message,
        "child-usage-capacity",
        state.root,
        "warning",
        "Claude child accounting capacity reached; additional message usage is omitted, native usage remains raw",
      );
    }
    return;
  }
  const messages = prior?.messages ?? new Map<string, Counts>();
  const previous = messages.get(id) ?? zero();
  const totals = prior?.total ?? zero();
  const total = zero();
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
  ] as const) {
    next[key] = Math.max(next[key], previous[key]);
    total[key] = Math.min(Number.MAX_SAFE_INTEGER, totals[key] + next[key] - previous[key]);
  }
  messages.set(id, next);
  if (next.reasoningTokens !== undefined || totals.reasoningTokens !== undefined) {
    next.reasoningTokens = Math.max(next.reasoningTokens ?? 0, previous.reasoningTokens ?? 0);
    total.reasoningTokens = Math.min(
      Number.MAX_SAFE_INTEGER,
      (totals.reasoningTokens ?? 0) + next.reasoningTokens - (previous.reasoningTokens ?? 0),
    );
  }
  state.childUsage.set(agent, { messages, total });
  state.emit({
    type: "usage",
    agent,
    ...total,
    counterMode: "cumulative",
    counterKey: state.key("child-usage", agent),
  });
}
