/** A screencast frame ready to draw, and how to free what holds it. */
export interface DecodedFrame {
  src: string;
  release(): void;
}

/**
 * Turns a frame's picture into something an `<img>` can show at once: the JPEG's bytes from a
 * binary frame, or the base64 of a `browser.frame` JSON message.
 */
export type FrameDecoder = (data: string | Uint8Array) => Promise<DecodedFrame>;

const keep = () => {};

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * Each frame becomes a Blob behind an object URL (revoked by `release` once the next frame
 * replaces it), decoded before it is handed over so the image shows it without a blank paint.
 * Binary frames go straight into the Blob, with no base64 on either end. The fake daemon's
 * frames are ready-made data URLs and stay so; where the platform has no object URLs a frame
 * becomes a data URL too.
 */
export const decodeFrame: FrameDecoder = async (data) => {
  if (typeof data === "string" && data.startsWith("data:")) return { src: data, release: keep };
  if (typeof URL.createObjectURL !== "function" || typeof Blob !== "function")
    return {
      src: `data:image/jpeg;base64,${typeof data === "string" ? data : base64Of(data)}`,
      release: keep,
    };
  const bytes = typeof data === "string" ? bytesOf(data) : new Uint8Array(data);
  const src = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  if (typeof Image === "function") {
    const image = new Image();
    image.src = src;
    if (typeof image.decode === "function") await image.decode().catch(() => {});
  }
  return { src, release: () => URL.revokeObjectURL(src) };
};
