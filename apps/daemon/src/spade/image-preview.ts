import { fitImage } from "@ace/provider-kit/image";

/*
 * A picture in a Spade conversation, previewed (ADR 0134): `GET /v1/images/{sha256}?preview` is
 * the daemon's, not Spade's. The daemon reads the image from Spade and answers a PNG at most
 * 512 pixels a side, as a thread attachment's thumbnail, so a phone drawing a chat never
 * downloads every original whole. Spade itself has no smaller copy.
 */

const previewRoute = /^\/v1\/images\/([0-9a-f]{64})\?preview$/;
/** Pictures a connection decodes at once; the rest wait their turn. */
const decodingAtOnce = 2;

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

/** `render`, run at most two at a time, the rest in the order they came. */
export function limitedRenders<T, R>(render: (input: T) => Promise<R>): (input: T) => Promise<R> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (input) => {
    // A finished render hands its place straight to the next in line, so none jumps ahead.
    if (running >= decodingAtOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await render(input);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
