import type { ModelDiscoveryError } from "@ace/protocol";

type Failure = {
  attempts: number;
  code: ModelDiscoveryError["code"];
  baseMs: number;
  retryAt: number;
};
/** One bounded schedule per source. Shared catalog queries wait for every failing source. */
export class DiscoveryBackoff {
  readonly #failures = new Map<string, Failure>();
  reset(): void {
    this.#failures.clear();
  }
  retain(sources: ReadonlySet<string>): void {
    for (const key of this.#failures.keys()) if (!sources.has(key)) this.#failures.delete(key);
  }
  fail(
    source: string,
    code: ModelDiscoveryError["code"],
    now: number,
    initialMs: number,
    jitter: number,
  ) {
    const old = this.#failures.get(source);
    const attempts = Math.min((old?.attempts ?? 0) + 1, 32);
    const base = Math.min(1_800_000, initialMs * 2 ** (attempts - 1));
    const delayMs = Math.min(
      1_800_000,
      Math.round(base * (0.8 + Math.max(0, Math.min(1, jitter)) * 0.4)),
    );
    if (!old && this.#failures.size >= 512) throw new Error("Discovery source limit reached");
    this.#failures.set(source, { attempts, code, baseMs: base, retryAt: now + delayMs });
    return {
      retryInMs: delayMs,
      level:
        !old || old.code !== code || old.baseMs !== base ? ("warn" as const) : ("debug" as const),
    };
  }
  retryAt(): number {
    let next = 0;
    for (const failure of this.#failures.values()) next = Math.max(next, failure.retryAt);
    return next;
  }
}
