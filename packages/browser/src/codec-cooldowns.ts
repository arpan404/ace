/*
 * Codecs whose encoder failed for a live capture (WebCodecs ran out of configurations), each
 * kept out for a cooldown and then tried again: a transient failure (a busy hardware encoder, a
 * GPU reset) never takes a codec away for good. The wait doubles with each failure in a row, up
 * to `maxCodecRetryMs`; a codec that stays quiet for twice that long starts over. Failures
 * belong to the tab whose capture they happened in (`clear` on another tab).
 */

/** The first wait after a codec's encoder failed. */
export const failedCodecRetryMs = 5_000;
/** The longest wait between tries of a failing codec. */
export const maxCodecRetryMs = 60_000;

type Failure = { count: number; at: number; until: number };

export class CodecCooldowns {
  readonly #failed = new Map<string, Failure>();

  /** `codec`'s encoder failed, now. */
  failed(codec: string, now: number): void {
    const was = this.#failed.get(codec);
    const count = was && now - was.at < 2 * maxCodecRetryMs ? was.count + 1 : 1;
    const wait = Math.min(failedCodecRetryMs * 2 ** (count - 1), maxCodecRetryMs);
    this.#failed.set(codec, { count, at: now, until: now + wait });
  }

  /** Whether `codec` waits out its cooldown now. */
  cooling(codec: string, now: number): boolean {
    const failure = this.#failed.get(codec);
    return failure !== undefined && now < failure.until;
  }

  /** Failures in a row of the most-failed of `codecs`: how many tries it has taken so far. */
  attempts(codecs: readonly string[]): number {
    return Math.max(0, ...codecs.map((codec) => this.#failed.get(codec)?.count ?? 0));
  }

  /** Another tab: nothing failed for it. */
  clear(): void {
    this.#failed.clear();
  }
}
