import type { MediaClock } from "./supervisor-host.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * Agent stills made by ace-media (docs/media/plan.md, F2): `still.take` for the current picture
 * of a source ace-media has, answered by `still.done` with the JPEG as its payload. Every other
 * end (`still.failed`, the deadline passing, ace-media unavailable or exiting) falls back to the
 * caller's legacy still maker, so an agent always gets its still, and gets it once.
 */

export type StillRoute = "ace-media" | "legacy";

/**
 * Where a still is made. `media.stills` is `legacy` by default; `auto` uses ace-media only while
 * it is healthy, so a still never waits on a process that isn't there.
 */
export function stillRoute(settings: MediaSettings, health: MediaHealth): StillRoute {
  return settings.stills === "auto" && health === "healthy" ? "ace-media" : "legacy";
}

export type StillSteps = Extract<FromMedia, { type: "still.done" }>["steps"];

export type StillRequest = {
  source: string;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  /** JPEG quality, 1 to 100. */
  quality: number;
  /** How long ace-media may take before the legacy path answers instead. */
  deadlineMs: number;
};

/** A still ace-media made: the JPEG, its size, and the path it took. */
export type MediaStill = { jpeg: Uint8Array; width: number; height: number; steps: StillSteps };

export type MediaStillsOptions = {
  settings: () => MediaSettings;
  health: () => MediaHealth;
  /** False when ace-media can't take the message. */
  send: (message: ToMedia) => boolean;
  clock: MediaClock;
  /** A request id unique for this daemon's lifetime. */
  nextId: () => string;
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
   * A still of `request.source`: from ace-media when the route says so and it answers in time,
   * otherwise from `legacy`. `adopt` turns ace-media's still into the caller's result type.
   */
  take<T>(
    request: StillRequest,
    legacy: () => Promise<T>,
    adopt: (still: MediaStill) => T,
  ): Promise<T> {
    const { settings, health, send, clock, nextId } = this.#options;
    if (stillRoute(settings(), health()) === "legacy") return legacy();
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
        if (end()) legacy().then(resolve, reject);
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

  /** ace-media exited or became unavailable: every waiting still is made the legacy way. */
  lost(): void {
    for (const pending of this.#pending.values()) pending.fallBack();
  }
}
