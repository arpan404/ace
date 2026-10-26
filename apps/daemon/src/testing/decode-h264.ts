/*
 * What a viewer's H.264 shows, as ffmpeg decodes it: for end-to-end tests that assert on
 * pictures (sizes, keyframes, whether the screen changed), not on messages. Needs ffmpeg.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

/** One decoded picture: its size, whether it was a keyframe, and its RGB pixels. */
export type Decoded = { width: number; height: number; key: boolean; pixels: Buffer };

const Probe = z.object({
  frames: z
    .array(z.object({ width: z.number(), height: z.number(), key_frame: z.number() }))
    .default([]),
});

let decodes = 0;

/**
 * Annex B H.264 access units, in arrival order, decoded frame by frame. With `keep` (a
 * directory), the stream is also left there as `<name>-<n>.h264` for a person to look at.
 */
export async function decodeH264(
  units: readonly Buffer[],
  keep?: { directory: string; name: string },
): Promise<Decoded[]> {
  const directory = await mkdtemp(join(tmpdir(), "ace-h264-"));
  try {
    const stream = join(directory, "view.h264");
    await writeFile(stream, Buffer.concat(units));
    if (keep) await mkdir(keep.directory, { recursive: true });
    if (keep)
      await writeFile(
        join(keep.directory, `${keep.name}-${++decodes}.h264`),
        await readFile(stream),
      );
    const probe = await exec(
      "ffprobe",
      ["-v", "error", "-f", "h264", "-show_frames", "-of", "json", stream],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const raw = join(directory, "view.rgb");
    const toRgb = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-y", raw];
    await exec("ffmpeg", ["-v", "error", "-f", "h264", "-i", stream, ...toRgb], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const pixels = await readFile(raw);
    let offset = 0;
    return Probe.parse(JSON.parse(probe.stdout)).frames.map((frame) => {
      const size = frame.width * frame.height * 3;
      const picture = pixels.subarray(offset, offset + size);
      offset += size;
      return {
        width: frame.width,
        height: frame.height,
        key: frame.key_frame === 1,
        pixels: picture,
      };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The share of pixels that differ by more than a little between two decoded pictures. */
export function changed(a: Decoded, b: Decoded): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let differing = 0;
  for (let index = 0; index < a.pixels.length; index += 3) {
    let distance = 0;
    for (let channel = 0; channel < 3; channel++)
      distance += Math.abs((a.pixels[index + channel] ?? 0) - (b.pixels[index + channel] ?? 0));
    if (distance > 72) differing++;
  }
  return differing / (a.pixels.length / 3);
}

/** The item at `index` (negative from the end); throws when there is none. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`Nothing at ${index} of ${items.length}`);
  return item;
}
