/**
 * What a scripted agent saw and did during one eval task. Pure: no I/O, no clock.
 *
 * Bytes stand in for model context. Tokens are an offline estimate (UTF-8 bytes / 4), the same
 * for every run, so before/after comparisons are fair even though no provider tokenizer is used.
 */
export interface TraceCall {
  readonly turn: number;
  readonly tool: string;
  /** Canonical JSON of the arguments, used to detect identical retries. */
  readonly args: string;
  /** Text the model would read back from the result. */
  readonly resultText: string;
  /** MCP `isError`, or an agent-control `{ ok: false }` result. */
  readonly failed: boolean;
  /** A call to the provider's own tools (shell, files), not to ace. */
  readonly native?: boolean;
}
export interface TraceContext {
  /** Guidance delivered once per session, through every channel the provider reads. */
  readonly instructions: string;
  /** Tool descriptors as the model sees them: name, description and input schema. */
  readonly toolDescriptors: string;
}
export interface TaskMetrics {
  readonly success: boolean;
  readonly aceCalls: number;
  /** Calls to the provider's own tools that ace could have made unnecessary. */
  readonly ownToolCalls: number;
  readonly failedCalls: number;
  /** A failed call repeated with the same tool and arguments. */
  readonly identicalRetries: number;
  readonly turns: number;
  readonly contextBytes: number;
  readonly tokens: number;
}

export const estimateTokens = (bytes: number) => Math.ceil(bytes / 4);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export function summarize(
  context: TraceContext,
  calls: readonly TraceCall[],
  turns: number,
  success: boolean,
): TaskMetrics {
  let identicalRetries = 0;
  const failedBefore = new Set<string>();
  let traffic = 0;
  for (const call of calls) {
    const key = `${call.tool}\u0000${call.args}`;
    if (failedBefore.has(key)) identicalRetries++;
    if (call.failed) failedBefore.add(key);
    traffic += bytes(call.tool) + bytes(call.args) + bytes(call.resultText);
  }
  const contextBytes = bytes(context.instructions) + bytes(context.toolDescriptors) + traffic;
  return {
    success,
    aceCalls: calls.filter((call) => !call.native).length,
    ownToolCalls: calls.filter((call) => call.native).length,
    failedCalls: calls.filter((call) => call.failed && !call.native).length,
    identicalRetries,
    turns,
    contextBytes,
    tokens: estimateTokens(contextBytes),
  };
}

/** Stable key order so that `{a,b}` and `{b,a}` count as the same retry. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}
