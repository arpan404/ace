import { unavailableImages, type ImageWork } from "@ace/media/images";

/*
 * A bridge for `SimulatorFrames`' live re-encode, which X1 (ADR 0201) removes along with this
 * file: until then a Simulator frame over its bound is fitted by ace-media's one-shot jobs,
 * the same call shape `@ace/provider-kit/image` had. The device platform installs its image
 * work here when it starts; before that, a frame that needs fitting fails `unavailable`.
 */

let frames: ImageWork = unavailableImages("no image work is installed for Simulator frames");

/** The device platform's image work, for Simulator frames. */
export function useSimulatorFrameImages(images: ImageWork): void {
  frames = images;
}

export async function fitImage(
  source: { input: Uint8Array; maxPixels: number; autoOrient: boolean },
  box: { width: number; height: number },
  encoding: { format: "jpeg"; quality: number } | { format: "png" },
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const fitted = await frames.run({
    inputs: [{ kind: "bytes", bytes: source.input }],
    op: {
      op: "fit",
      maxPixels: Math.min(source.maxPixels, 16 * 1024 * 1024),
      width: box.width,
      height: box.height,
      autoOrient: source.autoOrient,
      output: encoding,
    },
    deadlineMs: 2_000,
  });
  return { bytes: Buffer.from(fitted.bytes), width: fitted.width, height: fitted.height };
}
