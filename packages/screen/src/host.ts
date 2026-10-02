import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linuxBackend } from "./linux.ts";
import { ScreenManager } from "./manager.ts";
/** Local daemon boundary. Each artifact has a small adjacent manifest for later indexing. */
export function localScreenManager(helperPath: string, artifactDirectory: string): ScreenManager {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Native screen capture requires macOS or Linux");
  const backend = process.platform === "linux" ? linuxBackend(process.env) : undefined;
  return new ScreenManager({
    command: helperPath,
    ...(backend
      ? {
          protocolVersion: 2 as const,
          expectedPlatform: backend === "x11" ? ("linux-x11" as const) : ("linux-wayland" as const),
          args: [
            "--backend",
            backend,
            "--restore-token",
            join(artifactDirectory, "portal", "restore-token"),
          ],
          env: process.env,
        }
      : {}),
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
