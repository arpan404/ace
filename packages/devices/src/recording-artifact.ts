import { unlink } from "node:fs/promises";
import type { RecordingArtifact } from "@ace/screen";

/** The raw source belongs to export, including failed or cancelled publication. */
export async function consumeDeviceRecording<T>(
  artifact: RecordingArtifact,
  consume: () => Promise<T>,
): Promise<T> {
  try {
    return await consume();
  } finally {
    await unlink(artifact.path).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  }
}
