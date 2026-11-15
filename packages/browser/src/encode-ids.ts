import type { VideoEncode } from "./video-policy.ts";

/*
 * Encode ids in one capture's ace-media frames. Two plans run side by side in a capture, each
 * from its own range, so neither ever takes an id of the other's: ace-media's (D1) are
 * [1, 2^20), the daemon's own are [2^20, 2^31). Ids only grow and never wrap in place: a range
 * used up (about a million plans for ace-media's, two billion for the daemon's) has the source
 * opened again in ace-media under a fresh handle, and starts over only once every path that was
 * open has ended, its end marker proving its units are all in.
 */

export type IdRange = { first: number; end: number };

export const mediaIds: IdRange = { first: 1, end: 2 ** 20 };
export const daemonIds: IdRange = { first: 2 ** 20, end: 2 ** 31 };
/** The key prefix of an encode ace-media planned, which keeps ace-media's own id. */
export const mediaKey = "media/";

/** Dropped encodes' keys kept for their late units: far more than are ever in flight. */
const keptKeys = 4096;

/**
 * The daemon's next encode id from `next`, past the ids running now, and the one after it;
 * undefined once the range is used up.
 */
export function nextEncodeId(
  next: number,
  running: ReadonlySet<number>,
  range: IdRange = daemonIds,
): { id: number; next: number } | undefined {
  let id = Math.max(next, range.first);
  while (id < range.end && running.has(id)) id++;
  return id < range.end ? { id, next: id + 1 } : undefined;
}

export type EncodeIdsOptions = {
  daemonIds?: IdRange;
  /** The daemon's ids ran out: open the source again in ace-media, under a fresh handle. */
  renew: () => void;
};

/**
 * One capture's ids: ace-media's for the encodes it planned (pinned under the path the plan came
 * on), and the daemon's for its own. A daemon encode keeps its id while the plan has it; one the
 * plan drops keeps its key for late units, its id never handed on before the range starts over.
 */
export class EncodeIds {
  readonly #range: IdRange;
  readonly #renew: () => void;
  /** The path the capture streams to now, and ace-media's pins for it (key → id). */
  #current: string | undefined;
  readonly #pins = new Map<string, number>();
  /** Each open path's pins (id → key), kept for its late units until it ends. */
  readonly #media = new Map<string, Map<number, string>>();
  /** The daemon's keys running now, with their ids; and every daemon id's key. */
  readonly #daemon = new Map<string, number>();
  readonly #keys = new Map<number, string>();
  #next: number;
  /** Out of ids: the paths that must end before they start over. */
  #renewing: Set<string> | undefined;
  /** Ids that ran across the last reopen: never given to another encode before the next. */
  #carried = new Set<number>();

  constructor(options: EncodeIdsOptions) {
    this.#range = options.daemonIds ?? daemonIds;
    this.#renew = options.renew;
    this.#next = this.#range.first;
  }

  /**
   * The capture now streams to `path` (undefined: the daemon). The old path's encodes stop
   * stamping, so none of their units reach the new one; their labels stay for its late units.
   * True when the path changed.
   */
  pointed(path: string | undefined): boolean {
    if (path === this.#current) return false;
    this.#current = path;
    this.#pins.clear();
    if (path !== undefined) this.#media.set(path, new Map());
    return true;
  }

  /**
   * The path ended: every unit it carried is in. True when that let the daemon's ids start over
   * (encodes waiting for one can now run).
   */
  ended(path: string): boolean {
    this.#media.delete(path);
    if (!this.#renewing?.delete(path) || this.#renewing.size > 0) return false;
    this.#restart();
    return true;
  }

  /** An encode ace-media planned on the current path: its key keeps ace-media's id. */
  pin(key: string, id: number): boolean {
    const media = this.#current === undefined ? undefined : this.#media.get(this.#current);
    if (!media || id < mediaIds.first || id >= mediaIds.end) return false;
    this.#pins.set(key, id);
    media.set(id, key);
    return true;
  }

  /** The id an encode runs under, if it may run now. */
  id(key: string): number | undefined {
    if (key.startsWith(mediaKey)) return this.#pins.get(key);
    const running = this.#daemon.get(key);
    if (running !== undefined) return running;
    const id = this.#give();
    if (id === undefined) return undefined;
    this.#daemon.set(key, id);
    this.#keys.set(id, key);
    // Keys of dropped encodes stay for their late units, the oldest going past a bound.
    const live = new Set(this.#daemon.values());
    for (const old of this.#keys.keys()) {
      if (this.#keys.size <= keptKeys) break;
      if (!live.has(old)) this.#keys.delete(old);
    }
    return id;
  }

  /** The encode a unit of `path` stamped `id` belongs to. */
  key(id: number, path: string | undefined): string | undefined {
    if (id >= mediaIds.first && id < mediaIds.end)
      return path === undefined ? undefined : this.#media.get(path)?.get(id);
    return this.#keys.get(id);
  }

  /** The specs that can run now, with their ids, for producers that stamp frames with them. */
  stamp(specs: readonly VideoEncode[]): (VideoEncode & { id: number })[] {
    const keep = new Set(specs.map((spec) => spec.key));
    for (const key of this.#daemon.keys()) if (!keep.has(key)) this.#daemon.delete(key);
    return specs.flatMap((spec) => {
      const id = this.id(spec.key);
      return id === undefined ? [] : [{ ...spec, id }];
    });
  }

  #give(): number | undefined {
    if (this.#renewing) return undefined;
    const given = this.#take();
    if (given !== undefined) return given;
    // Used up: the source opens again under a fresh handle, and the ids start over once every
    // path open now has ended. Encodes running now keep theirs, and may have units on the way.
    this.#renewing = new Set(this.#media.keys());
    this.#carried = new Set(this.#daemon.values());
    this.#renew();
    if (this.#renewing.size > 0) return undefined;
    // No path was open: no unit carries these ids anywhere.
    this.#restart();
    return this.#take();
  }

  #take(): number | undefined {
    const running = new Set([...this.#daemon.values(), ...this.#carried]);
    const given = nextEncodeId(this.#next, running, this.#range);
    if (given) this.#next = given.next;
    return given?.id;
  }

  #restart(): void {
    this.#renewing = undefined;
    this.#next = this.#range.first;
  }
}
