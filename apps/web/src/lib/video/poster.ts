import type { MediaPoster } from "@ace/protocol";
import type { DecodedPicture } from "./codecs.ts";

/*
 * A subscribe's poster (ADR 0149): a viewport-sized JPEG still that shows within about a second
 * on a slow link, until the first video picture replaces it.
 */

/** A poster as a picture to draw; undefined when this platform can't decode it. */
export type PosterDecoder = (poster: MediaPoster) => Promise<DecodedPicture | undefined>;

/** The sequence a poster draws as: before any video chunk's. */
export const posterSequence = -1;

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> => {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
};

/** Decodes the JPEG with `createImageBitmap`; a poster that won't decode is skipped. */
export const imagePoster: PosterDecoder = async (poster) => {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(new Blob([bytesOf(poster.jpeg)], { type: "image/jpeg" }));
    return {
      sequence: posterSequence,
      draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    };
  } catch {
    return undefined;
  }
};

/** The poster as a `data:` URL, for a view that shows it as an image under its canvas. */
export const posterUrl = (poster: MediaPoster): string => `data:image/jpeg;base64,${poster.jpeg}`;
