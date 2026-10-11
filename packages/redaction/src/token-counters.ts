const TOKEN_COUNTERS = new Set([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "tokens",
]);
const NATIVE_TOKEN_COUNTERS = new Set(["input", "output", "reasoning", "total"]);
function nonnegativeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nativeTokenCounters(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([key, counter]) => {
      if (key !== "cache") return NATIVE_TOKEN_COUNTERS.has(key) && nonnegativeCounter(counter);
      return (
        counter !== null &&
        typeof counter === "object" &&
        !Array.isArray(counter) &&
        Object.entries(counter).every(
          ([name, count]) => (name === "read" || name === "write") && nonnegativeCounter(count),
        )
      );
    })
  );
}
export function accountingCounter(key: string, value: unknown): boolean {
  return (
    (TOKEN_COUNTERS.has(key) && nonnegativeCounter(value)) ||
    (key === "tokens" && nativeTokenCounters(value))
  );
}
