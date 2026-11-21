import { rename, rm } from "node:fs/promises";
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
 * into `root` and handed to `publish`. The directory is removed however publication ends, so a
 * failed or cancelled one leaves nothing behind but what was already published.
 */
export async function publishDeviceRecording(
  artifact: DeviceRecordingArtifact,
  root: string,
  publish: (part: PublishedPart) => Promise<void>,
): Promise<PublishedRecording> {
  try {
    let bytes = 0;
    for (const [n, part] of artifact.parts.toSorted((a, b) => a.index - b.index).entries()) {
      const id = n === 0 ? artifact.id : `${artifact.id}-${n + 1}`;
      const file = `${id}.mp4`;
      const path = join(root, file);
      // ace-media names its parts itself; only the base name is trusted to be inside the directory.
      await rename(join(artifact.directory, basename(part.path)), path);
      await publish({
        id,
        file,
        name: n === 0 ? "Device recording.mp4" : `Device recording (part ${n + 1}).mp4`,
        path,
        bytes: part.bytes,
      });
      bytes += part.bytes;
    }
    return { id: artifact.id, bytes, mimeType: "video/mp4" };
  } finally {
    await rm(artifact.directory, { recursive: true, force: true });
  }
}
