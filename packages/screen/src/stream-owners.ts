import type { ScreenStreamSettings } from "@ace/protocol";

/*
 * One capture's stream, shared by everyone who asks for it (a device's or a screen's viewers,
 * ace-media's views): each owner states the stream it needs, and the capture runs the one all of
 * them can take, the smallest of each. Updates are applied in order and coalesced while one is
 * outstanding, with no queue of old sizes. Devices' `DeviceStreamControl` and the screen's media
 * source both arbitrate through this.
 */

export type StreamResult = { codec: "jpeg" | "h264" };

/** Every owner decodes the shared capture's H.264: the slowest one sets its budget. */
export function commonStream(profiles: readonly ScreenStreamSettings[]): ScreenStreamSettings {
  return {
    codec: "h264",
    maxWidth: Math.min(...profiles.map((p) => p.maxWidth)),
    maxHeight: Math.min(...profiles.map((p) => p.maxHeight)),
    fps: Math.min(...profiles.map((p) => p.fps)),
    bitrate: Math.min(...profiles.map((p) => p.bitrate)),
  };
}

export function sameStream(a: ScreenStreamSettings, b: ScreenStreamSettings): boolean {
  return (
    a.codec === b.codec &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.fps === b.fps &&
    a.bitrate === b.bitrate
  );
}

export type StreamOwnersOptions = {
  apply: (settings: ScreenStreamSettings) => Promise<StreamResult>;
  /** What the capture runs with no owner; undefined: it is left as it is. */
  idle: () => ScreenStreamSettings | undefined;
  /** Checks an applied stream: a throw refuses it (the next update reapplies). */
  check?: (next: ScreenStreamSettings, result: StreamResult) => void;
  /** Owners at once. */
  limit?: number;
};

export class StreamOwners {
  readonly #options: StreamOwnersOptions;
  readonly #owners = new Map<string, ScreenStreamSettings>();
  #revision = 0;
  #applied = -1;
  #settings: ScreenStreamSettings | undefined;
  #result: StreamResult = { codec: "jpeg" };
  #running: Promise<StreamResult> | undefined;
  #closed = false;

  constructor(options: StreamOwnersOptions) {
    this.#options = options;
  }

  has(owner: string): boolean {
    return this.#owners.has(owner);
  }

  get size(): number {
    return this.#owners.size;
  }

  set(owner: string, settings: ScreenStreamSettings): Promise<StreamResult> {
    if (this.#closed) return Promise.reject(new Error("Stream closed"));
    if (!this.#owners.has(owner) && this.#owners.size >= (this.#options.limit ?? 64))
      return Promise.reject(new Error("Stream viewer limit"));
    this.#owners.set(owner, settings);
    return this.refresh();
  }

  /** The owner's demand ended: the others' stream (or the idle one) runs. */
  remove(owner: string): Promise<StreamResult> {
    if (this.#closed || !this.#owners.delete(owner)) return Promise.resolve(this.#result);
    return this.refresh();
  }

  async refresh(): Promise<StreamResult> {
    this.#revision++;
    // A no-op drain may already have settled when another update joins it.
    do {
      this.#running ??= this.#drain().finally(() => {
        this.#running = undefined;
      });
      await this.#running;
    } while (!this.#closed && this.#applied !== this.#revision);
    return this.#result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#owners.clear();
    // A refused update already failed its own caller; closing only waits for it to end.
    await this.#running?.catch(() => {});
  }

  async #drain(): Promise<StreamResult> {
    let result = this.#result;
    while (!this.#closed && this.#applied !== this.#revision) {
      const revision = this.#revision;
      const next = this.#owners.size
        ? commonStream([...this.#owners.values()])
        : this.#options.idle();
      if (next && (!this.#settings || !sameStream(this.#settings, next))) {
        // A refused update may have half-applied: the next one always reaches the capture.
        this.#settings = undefined;
        result = await this.#options.apply(next);
        this.#options.check?.(next, result);
        this.#settings = { ...next };
        this.#result = result;
      }
      this.#applied = revision;
    }
    return result;
  }
}
