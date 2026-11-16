import type { SuitManifest, SuitProblem } from "@ace/protocol/suits";
import { problem } from "./checks.ts";

/*
 * A Suit's video (ADR 0169), checked without touching the disk: every source is a video the
 * folder streams, the poster is an image it holds, and the video takes the app scene's place.
 */

const posterExtensions = /\.(webp|jpe?g|png|avif)$/i;

/**
 * Problems with `manifest.video`. `present` holds the files the reader read (the poster among
 * them), `streamed` the video files it streams.
 */
export function videoProblems(
  manifest: Pick<SuitManifest, "video" | "scenes">,
  present: ReadonlySet<string>,
  streamed: ReadonlySet<string>,
): SuitProblem[] {
  const video = manifest.video;
  if (!video) return [];
  const problems: SuitProblem[] = [];
  const seen = new Set<string>();
  for (const [index, source] of video.sources.entries()) {
    const field = `video.sources.${index}`;
    if (seen.has(source))
      problems.push(problem("video", `${field} names ${source} a second time`, field));
    else if (!streamed.has(source))
      problems.push(
        problem("video", `${field} names ${source}, which is missing or too large`, field),
      );
    seen.add(source);
  }
  if (video.poster !== undefined) {
    if (!present.has(video.poster))
      problems.push(
        problem("video", `video.poster names ${video.poster}, which is missing`, "video.poster"),
      );
    else if (!posterExtensions.test(video.poster))
      problems.push(
        problem("video", "video.poster must be a .webp, .jpg, .png or .avif image", "video.poster"),
      );
  }
  if (present.has("scene.js") || manifest.scenes?.app !== undefined)
    problems.push(
      problem(
        "video",
        "a Suit with a video has no app scene: the video is the app's backdrop; remove scene.js (or scenes.app), or move it to a region",
        "video",
      ),
    );
  return problems;
}
