import type { MediaClock } from "./supervisor-host.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import type { FromMedia, MediaFeature, ToMedia } from "./wire.ts";

/**
 * Agent stills made by ace-media (docs/media/plan.md, F2): `still.take` for the current picture
 * of a source ace-media has, answered by `still.done` with the JPEG as its payload. Every other
 * end (`still.failed`, the deadline passing, ace-media not healthy or exiting) falls back to the
 * source's own capture (the helper's JPEG, `simctl` or `adb` screenshots), so an agent always
 * gets its still, and gets it once. There is no legacy still maker since X1.
 */

export type StillSteps = Extract<FromMedia, { type: "still.done" }>["steps"];

export type StillRequest = {
  source: string;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** How long ace-media may take before the source's own capture answers instead. */
  deadlineMs: number;
  /**
   * For a request that isn't private: the newest public epoch the daemon announced for the
   * source (M8). ace-media answers only from a picture of that epoch or later, so private
   * content still in flight when the source went public is never this still.
   */
  minEpoch?: number;
};

/** A still ace-media made: the JPEG, its size, and the path it took. */
export type MediaStill = { jpeg: Uint8Array; width: number; height: number; steps: StillSteps };

export type MediaStillsOptions = {
  health: () => MediaHealth;
  /** False when ace-media can't take the message. */
  send: (message: ToMedia) => boolean;
  clock: MediaClock;
  /** A request id unique for this daemon's lifetime. */
  nextId: () => string;
  /** Whether the running ace-media agreed to an optional feature (`ready.features`). */
  speaks?: (feature: MediaFeature) => boolean;
};

type Pending = { done: (still: MediaStill) => void; fallBack: () => void };

export class MediaStills {
  readonly #options: MediaStillsOptions;
  readonly #pending = new Map<string, Pending>();

  constructor(options: MediaStillsOptions) {
    this.#options = options;
  }

  /** Requests waiting on ace-media. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * A still of `request.source`: from ace-media while it is healthy and answers in time,
   * otherwise from `capture`, the source's own. `adopt` turns ace-media's still into the
   * caller's result type.
   */
  take<T>(
    request: StillRequest,
    capture: () => Promise<T>,
    adopt: (still: MediaStill) => T,
  ): Promise<T> {
    const { health, send, clock, nextId } = this.#options;
    if (health() !== "healthy") return capture();
    // A fenced request goes only to a build that honours the fence; otherwise the source's own
    // capture answers rather than risk a still from before the epoch.
    if (request.minEpoch !== undefined && !(this.#options.speaks?.("picture-ingest") ?? false))
      return capture();
    const id = nextId();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const end = (): boolean => {
        if (settled) return false;
        settled = true;
        cancel();
        this.#pending.delete(id);
        return true;
      };
      const fallBack = () => {
        if (end()) capture().then(resolve, reject);
      };
      const cancel = clock.setTimeout(fallBack, request.deadlineMs);
      this.#pending.set(id, {
        done: (still) => {
          if (end()) resolve(adopt(still));
        },
        fallBack,
      });
      if (!send({ type: "still.take", request: id, ...request })) fallBack();
    });
  }

  /** A message from ace-media; those about other requests are ignored. */
  message(message: FromMedia, payload: Uint8Array): void {
    if (message.type !== "still.done" && message.type !== "still.failed") return;
    const pending = this.#pending.get(message.request);
    if (!pending) return;
    if (message.type === "still.failed") return pending.fallBack();
    // The payload buffer may be reused once this returns.
    const { width, height, steps } = message;
    pending.done({ jpeg: payload.slice(), width, height, steps });
  }

  /** ace-media exited or became unavailable: every waiting still comes from its source. */
  lost(): void {
    for (const pending of this.#pending.values()) pending.fallBack();
  }
}
