import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installScreenHelper } from "./install.ts";
import { dirname } from "node:path";
import { ScreenManager } from "./manager.ts";
/** Local daemon boundary. Each artifact has a small adjacent manifest for later indexing. */
export function localScreenManager(helperPath: string, artifactDirectory: string): ScreenManager {
  if (process.platform !== "darwin") throw new Error("Native screen capture requires macOS");
  return new ScreenManager({
    command: helperPath,
    prepare: () => installScreenHelper(helperPath, dirname(artifactDirectory)),
    nextId: randomUUID,
    recordingDirectory: artifactDirectory,
    publishArtifact: async (artifact) => {
      await writeFile(join(artifactDirectory, `${artifact.id}.json`), JSON.stringify(artifact), {
        flag: "wx",
        mode: 0o600,
      });
    },
  });
}
