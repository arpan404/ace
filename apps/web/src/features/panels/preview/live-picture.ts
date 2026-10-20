import type { DecodedPicture } from "@/lib/video/codecs.ts";
import type { ScreenFrame } from "../sources.ts";

/** A picture's sizes: CSS pixels of the page, and the decoded picture's own pixels. */
export interface PictureSizes {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
}

/**
 * A thread's live picture (ADR 0088): it holds only the newest decoded picture, freeing each
 * one a newer one replaces, and tells the canvases drawing it that there is a newer one. A
 * picture of other sizes needs a new `LivePicture`, so the view lays out again; same-sized
 * pictures replace each other in place, so nothing re-renders per picture.
 */
export class LivePicture implements ScreenFrame {
  readonly width: number;
  readonly height: number;
  readonly codedWidth: number;
  readonly codedHeight: number;
  #picture: DecodedPicture | undefined;
  #sequence: number;
  #listeners = new Set<() => void>();
  constructor(sizes: PictureSizes, picture: DecodedPicture) {
    this.width = sizes.width;
    this.height = sizes.height;
    this.codedWidth = sizes.codedWidth;
    this.codedHeight = sizes.codedHeight;
    this.#picture = picture;
    this.#sequence = picture.sequence;
  }
  get sequence(): number {
    return this.#sequence;
  }
  /** Whether a picture of these sizes can take this one's place without a new layout. */
  fits(sizes: PictureSizes): boolean {
    return (
      this.#picture !== undefined &&
      sizes.width === this.width &&
      sizes.height === this.height &&
      sizes.codedWidth === this.codedWidth &&
      sizes.codedHeight === this.codedHeight
    );
  }
  /** A newer picture of the same sizes: the one before is freed, and every drawer is told. */
  replace(picture: DecodedPicture): void {
    if (!this.#picture) return picture.close();
    this.#picture.close();
    this.#picture = picture;
    this.#sequence = picture.sequence;
    for (const listener of this.#listeners) listener();
  }
  draw(context: CanvasRenderingContext2D, width: number, height: number): boolean {
    if (!this.#picture) return false;
    try {
      this.#picture.draw(context, width, height);
      return true;
    } catch {
      return false;
    }
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** Frees the picture for good; canvases keep what they last drew. */
  release(): void {
    this.#picture?.close();
    this.#picture = undefined;
    this.#listeners.clear();
  }
}
