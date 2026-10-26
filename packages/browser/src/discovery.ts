import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { chromiumArtifact } from "./chromium-manifest.ts";

export async function detectChromium(
  options: {
    executablePath?: string;
    dataDir?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    arch?: string;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
  async function probePath(candidate: string | undefined): Promise<string | undefined> {
    if (!candidate) return undefined;
    try {
      await access(candidate, mode);
      return candidate;
    } catch {
      return undefined;
    }
  }
  for (const candidate of [options.executablePath, env.ACE_CHROMIUM_PATH]) {
    const found = await probePath(candidate);
    if (found) return found;
  }
  if (platform === "darwin") {
    for (const candidate of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const found = await probePath(candidate);
      if (found) return found;
    }
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA];
    for (const root of roots) {
      if (!root) continue;
      const found = await probePath(join(root, "Google/Chrome/Application/chrome.exe"));
      if (found) return found;
    }
    for (const root of roots) {
      if (!root) continue;
      const found = await probePath(join(root, "Microsoft/Edge/Application/msedge.exe"));
      if (found) return found;
    }
    // Explicit .exe names stay strictly executable: the shared lookup treats a
    // dotted base as exact, so no .bat/.cmd wrapper can win a browser launch.
    for (const command of ["chrome.exe", "chromium.exe", "msedge.exe"]) {
      const found = await findExecutable(command, env, platform);
      if (found) return found;
    }
  } else {
    for (const root of (env.PATH ?? "").split(delimiter)) {
      for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"])
        if (root) {
          const found = await probePath(join(root, name));
          if (found) return found;
        }
    }
  }
  if (options.dataDir) {
    // ace's own pinned Chrome for Testing, if it was acquired into this data directory.
    try {
      const artifact = chromiumArtifact(platform, arch);
      const path = join(
        options.dataDir,
        "chromium",
        `${artifact.version}-${artifact.checksum}`,
        artifact.executable,
      );
      await access(path, mode);
      return path;
    } catch {
      /* No downloaded browser. */
    }
  }
  return undefined;
}

export async function detectFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const root of (env.PATH ?? "").split(delimiter)) {
    const path = join(root, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Continue through PATH. */
    }
  }
  return undefined;
}

/** Explicit install uses the same pinned acquisition as lazy headless startup. */
export async function installChromium(
  dataDir: string,
  options: Omit<import("./acquisition.ts").ChromiumAcquisitionOptions, "dataDir"> = {},
): Promise<string> {
  const { acquireChromium } = await import("./acquisition.ts");
  return acquireChromium({ ...options, dataDir });
}
