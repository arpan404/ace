import type { ImageWork } from "@ace/media/images";

export interface ModelImageRuntime {
  /** The image scaled down to fit `box`, keeping its shape, as a JPEG of `quality`. */
  fit(
    input: Buffer,
    box: { width: number; height: number },
    quality: number,
  ): Promise<{ bytes: Buffer; width: number; height: number }>;
  after(milliseconds: number, expire: () => void): () => void;
}

/** The screens an agent's screenshot may come from: a 6K display is about 20 megapixels. */
const maxPixels = 50_000_000;

function after(milliseconds: number, expire: () => void): () => void {
  const timer = setTimeout(expire, milliseconds);
  return () => clearTimeout(timer);
}

/** The resize as ace-media's image process does it (ADR 0208). */
export function modelImageRuntime(images: ImageWork): ModelImageRuntime {
  return {
    async fit(input, box, quality) {
      const fitted = await images.run({
        inputs: [{ kind: "bytes", bytes: input }],
        op: {
          op: "fit",
          maxPixels,
          width: box.width,
          height: box.height,
          autoOrient: false,
          output: { format: "jpeg", quality },
        },
        deadlineMs: 10_000,
      });
      return { bytes: Buffer.from(fitted.bytes), width: fitted.width, height: fitted.height };
    },
    after,
  };
}

/** Without image work a screenshot that needs fitting fails, saying so. */
export const systemModelImageRuntime: ModelImageRuntime = {
  fit: () => Promise.reject(new Error("Screenshot resize needs ace-media's image process")),
  after,
};
