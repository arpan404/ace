import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { ScreenManager } from "./manager.ts";
/** Local daemon boundary. Each artifact has a small adjacent manifest for later indexing. */
export function localScreenManager(helperPath: string, artifactDirectory: string): ScreenManager {
  if (!["darwin", "win32"].includes(process.platform))
    throw new Error("No native helper for this platform");
  return new ScreenManager({
    command: helperPath,
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

/** Release packaging installs here once; launching never copies or rewrites the executable. */
export function screenHelperPath(
  dataDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32")
    return win32.join(dataDirectory, "helpers", "screen", "ace-screen-helper-windows.exe");
  if (platform === "darwin")
    return join(
      dataDirectory,
      "helpers",
      "screen",
      "AceScreenHelper.app",
      "Contents",
      "MacOS",
      "ace-screen-helper",
    );
  throw new Error("No native screen helper for this platform");
}
