import { readdir, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DeviceRecordingArtifact, PublishedRecording } from "./recording.ts";

/** One MP4 part of a recording, moved where the artifact registry keeps it. */
export type PublishedPart = {
  /** The artifact's id: the recording's for its first part, `<id>-<n>` for the n-th. */
  id: string;
  /** The file's name in the artifact root. */
  file: string;
  /** What a person sees: "Device recording.mp4", then "Device recording (part 2).mp4". */
  name: string;
  path: string;
  bytes: number;
};

/**
 * Publishes the parts ace-media wrote, in order: each is moved from the recording's directory
 * into `root` and handed to `publish`. Written video is never deleted. A publication that fails
 * stops there and says where the rest is; a file ace-media wrote but never reported (a stop that
 * timed out) stays in the directory, and the result names it. The directory goes only once
 * everything in it was published.
 */
export async function publishDeviceRecording(
  artifact: DeviceRecordingArtifact,
  root: string,
  publish: (part: PublishedPart) => Promise<void>,
): Promise<PublishedRecording> {
  let bytes = 0;
  for (const [n, part] of artifact.parts.toSorted((a, b) => a.index - b.index).entries()) {
    const id = n === 0 ? artifact.id : `${artifact.id}-${n + 1}`;
    const file = `${id}.mp4`;
    const path = join(root, file);
    try {
      // ace-media names its parts itself; only the base name is trusted to be inside the directory.
      await rename(join(artifact.directory, basename(part.path)), path);
      await publish({
        id,
        file,
        name: n === 0 ? "Device recording.mp4" : `Device recording (part ${n + 1}).mp4`,
        path,
        bytes: part.bytes,
      });
    } catch (error) {
      throw new Error(
        `The recording couldn't be published: its video is kept in ${artifact.directory} and ${root}`,
        { cause: error },
      );
    }
    bytes += part.bytes;
  }
  const left = await readdir(artifact.directory).catch(() => []);
  if (left.length)
    return {
      id: artifact.id,
      bytes,
      mimeType: "video/mp4",
      kept: { directory: artifact.directory, files: left.toSorted() },
    };
  await rmdir(artifact.directory).catch(() => {});
  return { id: artifact.id, bytes, mimeType: "video/mp4" };
}
