import type { ForgePrStatus } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import type { ReviewLoop } from "./review.ts";

export function nextPollDelay(
  failures: number,
  now: number,
  retryAt: number | undefined,
  baseMs = 15_000,
  maxMs = 300_000,
): number {
  if (
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    !Number.isFinite(now) ||
    baseMs <= 0 ||
    maxMs < baseMs
  )
    throw new RangeError("Invalid polling limits");
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 20));
  return Math.max(exponential, retryAt === undefined ? 0 : Math.max(0, retryAt - now));
}
/** One loop per owner. Inject wait for deterministic tests and daemon-owned timers. */
export async function watchPr(options: {
  loop: Pick<ReviewLoop, "poll">;
  threadId: string;
  signal: AbortSignal;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  onStatus: (status: ForgePrStatus) => Promise<void>;
  onError: (kind: string) => void;
  baseMs?: number;
  maxMs?: number;
}): Promise<void> {
  let failures = 0;
  let published: ForgePrStatus | undefined;
  while (!options.signal.aborted) {
    let retryAt: number | undefined;
    try {
      const status = await options.loop.poll(options.threadId, options.signal);
      failures = 0;
      if (status !== published) {
        await options.onStatus(status);
        published = status;
      }
      if (status.state === "closed" || status.state === "merged") return;
    } catch (error) {
      if (options.signal.aborted) return;
      failures = Math.min(failures + 1, 20);
      const safe = error instanceof ForgeError ? error : new ForgeError("cli");
      options.onError(safe.kind);
      retryAt = safe.retryAt;
      if (safe.kind === "not_found" || safe.kind === "forbidden" || safe.kind === "conflict")
        return;
    }
    if (options.signal.aborted) return;
    try {
      await options.wait(
        nextPollDelay(failures, options.now(), retryAt, options.baseMs, options.maxMs),
        options.signal,
      );
    } catch {
      if (!options.signal.aborted) throw new ForgeError("cli");
    }
  }
}
