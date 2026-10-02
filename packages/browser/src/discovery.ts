import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

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
  candidates.push(chromium.executablePath());
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
    const path = await cacheExecutable(options.dataDir);
    try {
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

function cacheExecutable(dataDir: string): Promise<string> {
  const require = createRequire(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { chromium } from 'playwright-core'; process.stdout.write(chromium.executablePath());",
      ],
      {
        cwd: join(require.resolve("playwright-core/package.json"), ".."),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dataDir, "chromium") },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 8192) output += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error("Chromium cache lookup failed")),
    );
  });
}

/** Explicit opt-in; never downloads during detection or service startup. */
export async function installChromium(dataDir: string): Promise<string> {
  const cache = join(dataDir, "chromium");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const require = createRequire(import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(require.resolve("playwright-core/package.json"), "..", "cli.js"),
        "install",
        "chromium",
      ],
      {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache },
        stdio: "inherit",
        timeout: 600_000,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Chromium install exited ${code}`)),
    );
  });
  return cacheExecutable(dataDir);
}
