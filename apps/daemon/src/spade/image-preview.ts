import { fitImage } from "@ace/provider-kit/image";

/*
 * A picture in a Spade conversation, previewed (ADR 0134): `GET /v1/images/{sha256}?preview` is
 * the daemon's, not Spade's. The daemon reads the image from Spade and answers a PNG at most
 * 512 pixels a side, as a thread attachment's thumbnail, so a phone drawing a chat never
 * downloads every original whole. Spade itself has no smaller copy.
 */

const previewRoute = /^\/v1\/images\/([0-9a-f]{64})\?preview$/;
/** The path of the image to read from Spade when `path` asks for its preview; else undefined. */
export function spadePreviewSource(method: string, path: string): string | undefined {
  if (method !== "GET") return undefined;
  const hash = previewRoute.exec(path)?.[1];
  return hash ? `/v1/images/${hash}` : undefined;
}

/** A PNG of at most 512 pixels a side, upright by its EXIF orientation. */
export async function renderSpadePreview(bytes: Uint8Array): Promise<Buffer> {
  const preview = await fitImage(
    { input: bytes, maxPixels: 40_000_000, autoOrient: true },
    { width: 512, height: 512 },
    { format: "png" },
  );
  return preview.bytes;
}

/** Why a preview didn't come: the daemon's places are full, or the decode ran past its time. */
export class PreviewBusy extends Error {
  constructor() {
    super("Spade's pictures are busy. Try again in a moment.");
    this.name = "PreviewBusy";
  }
}

/**
 * The daemon's places for previews, shared by every socket (one per `SpadeLink`). A place is
 * taken before the image is fetched, so `running` places bound the originals held (at most
 * `maxSpadeImageBytes` each) and the decodes at once; `waiting` more may queue, holding nothing
 * but their turn, and the rest are refused as busy. A waiting preview whose socket closed leaves
 * the line. A decode past `decodeMs` answers busy, but its place is kept until the decoder lets
 * go, since a decode can't be stopped.
 */
export class SpadePreviewGate {
  private running = 0;
  private readonly line: { start: () => void; signal: AbortSignal }[] = [];
  private readonly places: { running: number; waiting: number; decodeMs: number };
  private readonly render: (bytes: Buffer) => Promise<Buffer>;
  constructor(options: {
    running: number;
    waiting: number;
    decodeMs: number;
    render: (bytes: Buffer) => Promise<Buffer>;
  }) {
    this.places = options;
    this.render = options.render;
  }

  /**
   * `fetch` the image in a place, then decode its preview there; undefined when `fetch` found
   * none. Throws `PreviewBusy` when no place is free or the decode is late, and `signal`'s
   * reason when it aborts while waiting.
   */
  async preview(
    signal: AbortSignal,
    fetch: () => Promise<Buffer | undefined>,
    later: (ms: number, callback: () => void) => () => void,
  ): Promise<Buffer | undefined> {
    await this.enter(signal);
    let bytes: Buffer | undefined;
    try {
      bytes = await fetch();
    } catch (error) {
      this.leave();
      throw error;
    }
    if (!bytes) {
      this.leave();
      return undefined;
    }
    const decode = this.render(bytes);
    // The place is the decoder's until it lets go, answered or not.
    void decode.then(
      () => this.leave(),
      () => this.leave(),
    );
    return new Promise<Buffer>((resolve, reject) => {
      const cancel = later(this.places.decodeMs, () => reject(new PreviewBusy()));
      decode.then(
        (preview) => {
          cancel();
          resolve(preview);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });
  }

  private enter(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.running < this.places.running) {
      this.running++;
      return Promise.resolve();
    }
    if (this.line.length >= this.places.waiting) return Promise.reject(new PreviewBusy());
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        start: () => {
          signal.removeEventListener("abort", gone);
          resolve();
        },
      };
      const gone = () => {
        const at = this.line.indexOf(waiter);
        if (at >= 0) this.line.splice(at, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", gone, { once: true });
      this.line.push(waiter);
    });
  }

  /** A finished preview hands its place straight to the next in line, so none jumps ahead. */
  private leave() {
    const next = this.line.shift();
    if (next) next.start();
    else this.running--;
  }
}

/** The daemon's previews: two at once, sixteen waiting, fifteen seconds to decode. */
export function spadePreviewGate(): SpadePreviewGate {
  return new SpadePreviewGate({
    running: 2,
    waiting: 16,
    decodeMs: 15_000,
    render: renderSpadePreview,
  });
}
