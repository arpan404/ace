import { fitImage } from "@ace/provider-kit/image";

export interface ModelImageRuntime {
  /** The image scaled down to fit `box`, keeping its shape, as a JPEG of `quality`. */
  fit(
    input: Buffer,
    box: { width: number; height: number },
    quality: number,
  ): Promise<{ bytes: Buffer; width: number; height: number }>;
  after(milliseconds: number, expire: () => void): () => void;
}

/** The images an agent's screenshot may decode: sharp's old bound, about 268 MP. */
const maxPixels = 0x3fff * 0x3fff;

/**
 * The sole system boundary. The resize is `fitImage` (`@ace/provider-kit/image`); X4 moves it
 * into ace-media. Tests supply the resize and the deadline.
 */
export const systemModelImageRuntime: ModelImageRuntime = {
  fit: (input, box, quality) =>
    fitImage({ input, maxPixels, autoOrient: false }, box, { format: "jpeg", quality }),
  after(milliseconds, expire) {
    const timer = setTimeout(expire, milliseconds);
    return () => clearTimeout(timer);
  },
};
