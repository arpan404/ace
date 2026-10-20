import { afterEach, vi } from "vitest";

/** A decoded picture the page owns until it closes it. */
interface StandInFrame {
  readonly timestamp: number;
  closed: boolean;
  close(): void;
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) restore();
  vi.unstubAllGlobals();
});

/**
 * The browser under a live page's view, for one test. jsdom has no WebCodecs and no 2D canvas,
 * and a live page shows only as video (ADR 0088), so this stands in for both at the platform
 * boundary: a `VideoDecoder` that decodes every chunk into a picture after `decode` returns, in
 * order, and canvases that record each open picture drawn on them. Undone after the test.
 */
export function browserVideo() {
  const frames: StandInFrame[] = [];
  const drawn = new Map<Element, number>();
  const shown = new Map<Element, number>();
  class Frame implements StandInFrame {
    readonly timestamp: number;
    closed = false;
    constructor(timestamp: number) {
      this.timestamp = timestamp;
    }
    close() {
      this.closed = true;
    }
  }
  class Decoder {
    static isConfigSupported(config: unknown) {
      return Promise.resolve({ supported: true, config });
    }
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    readonly #output: (frame: Frame) => void;
    constructor(init: { output(frame: Frame): void }) {
      this.#output = init.output;
    }
    configure() {
      this.state = "configured";
    }
    decode(chunk: { timestamp: number }) {
      if (this.state !== "configured")
        throw new DOMException("The decoder isn't configured", "InvalidStateError");
      queueMicrotask(() => {
        if (this.state !== "configured") return;
        const frame = new Frame(chunk.timestamp);
        frames.push(frame);
        this.#output(frame);
      });
    }
    close() {
      this.state = "closed";
    }
  }
  class Chunk {
    readonly timestamp: number;
    constructor(init: { timestamp: number }) {
      this.timestamp = init.timestamp;
    }
  }
  const context = (canvas: HTMLCanvasElement) => ({
    drawImage(image: StandInFrame) {
      // A closed picture draws nothing: only open ones count.
      if (image.closed) return;
      drawn.set(canvas, (drawn.get(canvas) ?? 0) + 1);
      shown.set(canvas, image.timestamp);
    },
  });
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", Chunk);
  const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return context(this);
    },
  });
  restores.push(() => {
    if (original) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
  });
  return {
    /** Pictures decoded so far, oldest first. */
    frames,
    /** How many pictures were drawn on `canvas`. */
    draws: (canvas: Element) => drawn.get(canvas) ?? 0,
    /** The chunk sequence of the picture `canvas` shows now (decoders carry it as timestamp). */
    shown: (canvas: Element) => shown.get(canvas),
  };
}
