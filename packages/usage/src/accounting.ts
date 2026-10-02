import type { UsageUpdated } from "@ace/protocol";
import { normalizeUsage, zeroCounts, type Counts } from "./counters.ts";

type Sample = Omit<UsageUpdated, "agentId" | "model"> & { model?: string | null | undefined };
/** Pure provider policy; explicit adapter metadata always takes precedence. */
export function counterPolicy(sample: Sample, provider: string, run: string) {
  const mode =
    sample.counterMode ??
    (provider === "codex" || provider === "claude" ? "cumulative" : "incremental");
  const scope =
    sample.counterKey === undefined
      ? provider === "claude"
        ? `legacy:run:${run}`
        : "legacy"
      : `key:${sample.counterKey}`;
  return { mode, scope, tracked: mode === "cumulative" || sample.counterKey !== undefined };
}
export function accountSample(
  sample: Sample,
  provider: string,
  mode: "cumulative" | "incremental",
  previous?: Counts,
): { delta: Counts; next: Counts } {
  if (mode === "incremental" && previous) return { delta: zeroCounts, next: previous };
  // Legacy CLI counters exclude cache input, and OpenCode excludes reasoning output.
  // Explicit counterMode declares canonical inclusive counts instead.
  const legacy = sample.counterMode === undefined && provider !== "codex";
  return normalizeUsage(
    {
      ...sample,
      model: sample.model ?? undefined,
      inputTokens:
        sample.inputTokens +
        (legacy ? (sample.cachedInputTokens ?? 0) + (sample.cacheWriteTokens ?? 0) : 0),
      outputTokens:
        sample.outputTokens +
        (legacy && provider === "opencode" ? (sample.reasoningTokens ?? 0) : 0),
    },
    previous ?? zeroCounts,
  );
}
