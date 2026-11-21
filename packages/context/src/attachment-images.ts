import { ImageError, type ImageWork } from "@ace/media/images";
import { ContextError } from "./errors.ts";
import { defaultImageLimits } from "./media.ts";

/*
 * Attachment pictures through ace-media (ADR 0201): the preview a client shows, and the copy an
 * inline provider gets when the original is over its budget. The stored original is never
 * changed; both read it by path, so its bytes never pass through the daemon.
 */

/** A file ace-media may read for one job. */
const fileBound = 32 * 1024 * 1024;
const deadlineMs = 15_000;

/** A PNG preview of at most 512 px a side, upright by its EXIF orientation. */
export function thumbnailRenderer(images: ImageWork): (path: string) => Promise<Buffer> {
  return async (path) => {
    try {
      const preview = await images.run({
        inputs: [{ kind: "file", path, maxBytes: fileBound }],
        op: {
          op: "fit",
          // What an upload may hold at most: the same bound, not a larger one.
          maxPixels: defaultImageLimits.maxPixels,
          width: 512,
          height: 512,
          autoOrient: true,
          output: { format: "png" },
        },
        deadlineMs,
      });
      return Buffer.from(preview.bytes);
    } catch (error) {
      if (!(error instanceof ImageError)) throw error;
      throw new ContextError(error.passing ? "busy" : "unsupported", error.message);
    }
  };
}

/** The longest side a provider takes an image at (larger ones it scales down itself). */
export const modelImageSide = 1568;
/** Past this a provider refuses an image outright. */
export const providerImageSide = 8000;

/**
 * A JPEG of the image within `budget` bytes and 1,568 px a side, for a provider whose inline
 * budget the original doesn't fit; undefined when no such copy can be made now.
 */
export async function modelImageCopy(
  images: ImageWork,
  path: string,
  budget: number,
): Promise<Buffer | undefined> {
  // Smaller and coarser until it fits: the budget is the inline bound, not a quality target.
  for (const [side, quality] of [
    [modelImageSide, 80],
    [1092, 70],
    [768, 60],
  ] as const) {
    const copy = await images
      .run({
        inputs: [{ kind: "file", path, maxBytes: fileBound }],
        op: {
          op: "fit",
          maxPixels: defaultImageLimits.maxPixels,
          width: side,
          height: side,
          autoOrient: true,
          output: { format: "jpeg", quality, background: [255, 255, 255] },
        },
        deadlineMs,
      })
      .catch((error: unknown) => {
        if (error instanceof ImageError) return undefined;
        throw error;
      });
    if (!copy) return undefined;
    if (copy.bytes.length <= budget) return Buffer.from(copy.bytes);
  }
  return undefined;
}
