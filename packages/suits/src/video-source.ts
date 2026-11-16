/*
 * Which of a Suit's video renditions plays (ADR 0169). Pure: each file's real size, read from its
 * own metadata, against the window in device pixels. The smallest rendition that shows sharp
 * plays, so a 4K file decodes only where a 4K picture can be seen; with none that sharp, the
 * largest plays. Nothing is upscaled or labelled beyond what the file holds.
 */

export interface ProbedVideo {
  path: string;
  /** The file's own picture size, from its metadata (`videoWidth`, `videoHeight`). */
  width: number;
  height: number;
}

export interface VideoTarget {
  /** The backdrop in device pixels. */
  width: number;
  height: number;
  fit: "cover" | "contain";
}

/** Whether `video` shows at its own size or smaller in `target`: no stretching past a pixel. */
export function showsSharp(video: Pick<ProbedVideo, "width" | "height">, target: VideoTarget) {
  if (video.width <= 0 || video.height <= 0) return false;
  const scale =
    target.fit === "cover"
      ? Math.max(target.width / video.width, target.height / video.height)
      : Math.min(target.width / video.width, target.height / video.height);
  return scale <= 1.001;
}

/** The rendition to play; undefined when none has a size yet. */
export function pickVideoSource(
  probed: readonly ProbedVideo[],
  target: VideoTarget,
): ProbedVideo | undefined {
  const sized = probed
    .filter((video) => video.width > 0 && video.height > 0)
    .toSorted((a, b) => a.width * a.height - b.width * b.height);
  return sized.find((video) => showsSharp(video, target)) ?? sized.at(-1);
}

/** How a picture's size reads in Settings: its own pixels, and 4K only when it has them. */
export function videoSizeLabel(video: Pick<ProbedVideo, "width" | "height">): string {
  const short = Math.min(video.width, video.height);
  const name =
    short >= 2160
      ? "4K"
      : short >= 1440
        ? "1440p"
        : short >= 1080
          ? "1080p"
          : short >= 720
            ? "720p"
            : undefined;
  const size = `${video.width} × ${video.height}`;
  return name ? `${name} (${size})` : size;
}
