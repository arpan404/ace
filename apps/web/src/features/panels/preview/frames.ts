/** A screencast frame ready to draw, and how to free what holds it. */
export interface DecodedFrame {
  src: string;
  release(): void;
}

/** Turns a `browser.frame` payload into something an `<img>` can show at once. */
export type FrameDecoder = (data: string) => Promise<DecodedFrame>;

const keep = () => {};

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The daemon sends base64 JPEG frames: each becomes a Blob behind an object URL (revoked by
 * `release` once the next frame replaces it), decoded before it is handed over so the image
 * shows it without a blank paint. The fake daemon's frames are ready-made data URLs and stay so;
 * where the platform has no object URLs a JPEG frame becomes a data URL too.
 */
export const decodeFrame: FrameDecoder = async (data) => {
  if (data.startsWith("data:")) return { src: data, release: keep };
  if (typeof URL.createObjectURL !== "function" || typeof Blob !== "function")
    return { src: `data:image/jpeg;base64,${data}`, release: keep };
  const src = URL.createObjectURL(new Blob([bytesOf(data)], { type: "image/jpeg" }));
  if (typeof Image === "function") {
    const image = new Image();
    image.src = src;
    if (typeof image.decode === "function") await image.decode().catch(() => {});
  }
  return { src, release: () => URL.revokeObjectURL(src) };
};
