import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { chromiumArtifact } from "./chromium-manifest.ts";

export async function detectChromium(
  options: {
    executablePath?: string;
    dataDir?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const candidates = [options.executablePath, env.ACE_CHROMIUM_PATH];
  if (platform === "darwin")
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  if (platform === "win32")
    for (const root of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
      if (root) candidates.push(join(root, "Google/Chrome/Application/chrome.exe"));
    }
  for (const root of (env.PATH ?? "").split(delimiter)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"])
      if (root) candidates.push(join(root, name));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try next installation. */
    }
  }
  if (options.dataDir) {
    // ace's own pinned Chrome for Testing, if it was acquired into this data directory.
    try {
      const artifact = chromiumArtifact(platform, process.arch);
      const path = join(
        options.dataDir,
        "chromium",
        `${artifact.version}-${artifact.checksum}`,
        artifact.executable,
      );
      await access(path, constants.X_OK);
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
