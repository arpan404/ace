/*
 * Pictures that arrive while a subscribe naming a media connection waits for its reply (ADR 0147
 * §4). Until the reply says which way the source is delivered, pictures may come either way: the
 * daemon may replay the source's last picture on the channel before answering that it serves it
 * there itself (a static page then sends nothing more), or ace-media may start before the reply.
 * Each way keeps its newest keyframe and the deltas after it, bounded; the reply releases the way
 * it settled on, and the rest are dropped.
 */

/** What the buffer needs to know of a picture. */
export interface CandidateShape {
  key: boolean;
  /** Capture time, in ms. */
  timestamp: number;
  bytes: Uint8Array;
}

/** About a few seconds of a fast stream, and never more than this. */
export const candidateLimits = { bytes: 4 * 1024 * 1024, ms: 2_000 } as const;

interface Way<T> {
  pictures: T[];
  bytes: number;
  /** Past the bounds: only the keyframe is kept (if it fit), and a fresh one is due. */
  overflowed: boolean;
  /** The keyframe a fresh one is asked for in the name of (bytes dropped when it didn't fit). */
  ask: T | undefined;
}

/**
 * What a settled way releases: its pictures, in order, and whether a fresh keyframe is due, with
 * the keyframe to ask for it in the name of (its header; the bytes may be gone).
 */
export interface Released<T> {
  pictures: T[];
  needsKeyframe: boolean;
  ask?: T;
}

export class DeliveryCandidates<T extends CandidateShape> {
  #ways = new Map<string, Way<T>>();
  #limits: { bytes: number; ms: number };
  constructor(limits: { bytes: number; ms: number } = candidateLimits) {
    this.#limits = limits;
  }
  /** A picture that came by `path` before the reply. */
  hold(path: string, picture: T): void {
    if (picture.key) {
      if (picture.bytes.length > this.#limits.bytes) {
        // Too large to hold: only its header is kept, to ask for a fresh one once settled.
        const header = { ...picture, bytes: new Uint8Array(0) };
        this.#ways.set(path, { pictures: [], bytes: 0, overflowed: true, ask: header });
        return;
      }
      this.#ways.set(path, {
        pictures: [picture],
        bytes: picture.bytes.length,
        overflowed: false,
        ask: undefined,
      });
      return;
    }
    const way = this.#ways.get(path);
    // A delta with no keyframe before it can't be shown; past the bounds, the gap stays open.
    if (!way || way.overflowed) return;
    const first = way.pictures[0];
    const bytes = way.bytes + picture.bytes.length;
    if (
      !first ||
      bytes > this.#limits.bytes ||
      picture.timestamp - first.timestamp > this.#limits.ms
    ) {
      way.pictures = first ? [first] : [];
      way.bytes = first?.bytes.length ?? 0;
      way.overflowed = true;
      way.ask = first;
      return;
    }
    way.pictures.push(picture);
    way.bytes = bytes;
  }
  /** The reply settled on `path`: its pictures, and everything else dropped. */
  settle(path: string): Released<T> {
    const way = this.#ways.get(path);
    this.#ways.clear();
    if (!way) return { pictures: [], needsKeyframe: false };
    return {
      pictures: way.pictures,
      needsKeyframe: way.overflowed,
      ...(way.overflowed && way.ask ? { ask: way.ask } : {}),
    };
  }
  clear(): void {
    this.#ways.clear();
  }
}
