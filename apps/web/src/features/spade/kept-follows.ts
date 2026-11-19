/** How many lately opened conversations stay kept per Spade connection. */
const keep = 8;

/**
 * Conversations opened lately, no longer followed live but kept as they were last seen: opening
 * one again shows it at once, at the end the person left, and its stream picks up after the last
 * message it holds (a follow resumes where it stopped). The latest few per Spade connection stay;
 * older ones are let go and read afresh next time.
 */
export class KeptFollows<F> {
  private readonly kept = new WeakMap<object, Map<string, F>>();

  /** The follow kept for `key` on `owner` (the Spade connection), or a new one from `make`. */
  take(owner: object, key: string, make: () => F): F {
    let follows = this.kept.get(owner);
    if (!follows) {
      follows = new Map();
      this.kept.set(owner, follows);
    }
    const follow = follows.get(key) ?? make();
    // The newest at the end: taking one moves it there.
    follows.delete(key);
    follows.set(key, follow);
    for (const oldest of follows.keys()) {
      if (follows.size <= keep) break;
      follows.delete(oldest);
    }
    return follow;
  }
}
