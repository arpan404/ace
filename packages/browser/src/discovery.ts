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
    /** Windows only: the architecture of ace's own pinned browser. */
    arch?: string;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return detectWindowsChromium(options, env);
  const candidates = [options.executablePath, env.ACE_CHROMIUM_PATH];
  if (platform === "darwin")
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
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

/** Windows has no execute bit: existence is the test, and PATH lookup never accepts a .bat/.cmd. */
async function detectWindowsChromium(
  options: { executablePath?: string; dataDir?: string; arch?: string },
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const exists = (path: string) =>
    access(path).then(
      () => path,
      () => undefined,
    );
  const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
    (root): root is string => Boolean(root),
  );
  const installed = [
    options.executablePath,
    env.ACE_CHROMIUM_PATH,
    ...roots.map((root) => join(root, "Google/Chrome/Application/chrome.exe")),
    ...roots.map((root) => join(root, "Microsoft/Edge/Application/msedge.exe")),
  ];
  for (const candidate of installed) {
    const found = candidate && (await exists(candidate));
    if (found) return found;
  }
  for (const command of ["chrome.exe", "chromium.exe", "msedge.exe"]) {
    const found = await findExecutable(command, env, "win32");
    if (found) return found;
  }
  if (!options.dataDir) return undefined;
  try {
    // ace's own pinned Chrome for Testing, if it was acquired into this data directory.
    const artifact = chromiumArtifact("win32", options.arch ?? process.arch);
    return await exists(
      join(
        options.dataDir,
        "chromium",
        `${artifact.version}-${artifact.checksum}`,
        artifact.executable,
      ),
    );
  } catch {
    return undefined;
  }
}

/** Chrome for Testing has no Windows ARM64 build, so ace runs the installed Chrome or Edge there. */
export async function installedWindowsChromium(options: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const installed = await detectChromium({ ...options, platform: "win32" });
  if (installed) return installed;
  throw new Error("Install Chrome or Microsoft Edge to use ace's browser on Windows ARM64");
}
