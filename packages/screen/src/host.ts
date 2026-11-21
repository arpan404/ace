import type { MediaRecorder } from "@ace/media/tee-recordings";
import type { ScreenCowork } from "./cowork.ts";
import { linuxLaunch, installedLinuxHelper } from "./linux.ts";
import { graphicalSessionEnvironment } from "./linux-session.ts";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { installScreenHelper } from "./install.ts";
import { dirname } from "node:path";
import type { ScreenMedia } from "./media-source.ts";
import { ScreenManager } from "./manager.ts";
/** Local daemon boundary. Each artifact has a small adjacent manifest for later indexing. */
export function localScreenManager(
  helperPath: string,
  artifactDirectory: string,
  options: {
    manifest?: string | undefined;
    /**
     * Development only: keep macOS permissions with the launching process (a terminal that
     * already holds them) instead of the helper's own identity.
     */
    inheritResponsibility?: boolean | undefined;
    /** Linux: the graphical session environment, read each time a helper starts. */
    session?: (() => Promise<NodeJS.ProcessEnv>) | undefined;
    /** Cowork with the person (ADR 0143), shared with the computer-use tools. */
    cowork?: ScreenCowork | undefined;
    /** ace-media's producers (ADR 0147, phase 2): where Mac screens stream while routed. */
    media?: ScreenMedia | undefined;
    /** ace-media's recorder (X1): every screen recording goes through it. */
    recorder?: MediaRecorder | undefined;
  } = {},
): ScreenManager {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error("No native helper for this platform");
  // The service may start before anyone logs in: the backend is chosen when a helper starts,
  // so a headless daemon still starts and only a screen request reports the missing session.
  const session =
    process.platform === "linux"
      ? (options.session ?? graphicalSessionEnvironment({ env: process.env }))
      : undefined;
  return new ScreenManager({
    ...(session
      ? {
          protocolVersion: 2 as const,
          launch: async () => linuxLaunch(await session(), artifactDirectory),
        }
      : {}),
    command: helperPath,
    ...(process.platform === "darwin"
      ? {
          ...(options.inheritResponsibility ? { args: ["--inherit-responsibility"] } : {}),
          prepare: () =>
            installScreenHelper(helperPath, dirname(artifactDirectory), options.manifest),
        }
      : {}),
    nextId: randomUUID,
    ...(options.cowork ? { cowork: options.cowork } : {}),
    ...(options.media ? { media: options.media } : {}),
    ...(options.recorder ? { recorder: options.recorder } : {}),
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
  if (platform === "linux") return installedLinuxHelper(dataDirectory, process.arch);
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
