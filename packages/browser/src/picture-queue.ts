import type { PictureChunk } from "./stream-picture.ts";

/**
 * One live picture as a view draws it: a picture kind's chunk and the source it shows (a device
 * id, or a computer-use session id). The daemon paces every live picture: ack it once shown.
 */
export interface SourcePicture extends PictureChunk {
  sourceId: string;
}

/** A view's pictures waiting to be drawn, at most this many. */
const queueLimit = 16;

interface Viewer {
  draw(picture: SourcePicture): Promise<void>;
  queue: SourcePicture[];
  busy: boolean;
  active: boolean;
}

/**
 * Each source's pictures to its views, in order and one draw at a time. H.264 can't skip a
 * picture, so nothing is replaced while there's room; a view that falls a whole queue behind
 * keeps only the newest picture, and its decoder sees the gap and asks for a keyframe. The
 * daemon's ack window keeps the stream far below the limit.
 */
export class PictureQueue {
  readonly #viewers = new Map<string, Set<Viewer>>();
  readonly #sources: number;
  /** `sources`: how many sources may have views at once. */
  constructor(sources: number) {
    this.#sources = sources;
  }
  watch(sourceId: string, draw: (picture: SourcePicture) => Promise<void>): () => void {
    let viewers = this.#viewers.get(sourceId);
    if (!viewers) {
      if (this.#viewers.size >= this.#sources) throw new Error("Picture view limit");
      viewers = new Set();
      this.#viewers.set(sourceId, viewers);
    }
    if (viewers.size >= 16) throw new Error("Picture view limit");
    const viewer: Viewer = { draw, queue: [], busy: false, active: true };
    viewers.add(viewer);
    const set = viewers;
    return () => {
      viewer.active = false;
      viewer.queue = [];
      set.delete(viewer);
      if (!set.size && this.#viewers.get(sourceId) === set) this.#viewers.delete(sourceId);
    };
  }
  publish(picture: SourcePicture): void {
    for (const viewer of this.#viewers.get(picture.sourceId) ?? []) {
      if (viewer.queue.length >= queueLimit) viewer.queue = [];
      viewer.queue.push(picture);
      if (!viewer.busy) this.#drain(viewer);
    }
  }
  /** Forget one source's queued pictures (its session ended); its views stay. */
  discardSource(sourceId: string): void {
    for (const viewer of this.#viewers.get(sourceId) ?? []) viewer.queue = [];
  }
  /** Forget queued pictures (the connection ended); the views stay. */
  discard(): void {
    for (const viewers of this.#viewers.values()) for (const viewer of viewers) viewer.queue = [];
  }
  #drain(viewer: Viewer): void {
    const next = viewer.queue.shift();
    if (!next || !viewer.active) {
      viewer.busy = false;
      return;
    }
    viewer.busy = true;
    void Promise.resolve()
      .then(() => viewer.draw(next))
      .catch(() => {})
      .then(() => this.#drain(viewer));
  }
}
