import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnProcess, type ProcessSpawner } from "./io.ts";
import { createRequire } from "node:module";
import { z } from "zod";
import { chromium } from "playwright-core";

export async function detectChromium(
  options: {
    executablePath?: string;
    dataDir?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    spawn?: ProcessSpawner;
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
    const path = await cacheExecutable(options.dataDir, options.spawn);
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

function cacheExecutable(dataDir: string, spawn: ProcessSpawner = spawnProcess): Promise<string> {
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
    let overflow = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (raw: unknown) => {
      const chunk = z.string().max(8192).safeParse(raw);
      if (!chunk.success || output.length + chunk.data.length > 8192) {
        overflow = true;
        child.kill();
      } else output += chunk.data;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const path = z
        .string()
        .min(1)
        .max(8192)
        .refine((value) => !/[\0\r\n]/.test(value))
        .safeParse(output);
      if (code === 0 && !overflow && path.success) resolve(path.data);
      else reject(new Error("Chromium cache lookup failed"));
    });
  });
}

/** Explicit install uses the same pinned acquisition as lazy headless startup. */
export async function installChromium(
  dataDir: string,
  options: Omit<import("./acquisition.ts").ChromiumAcquisitionOptions, "dataDir"> = {},
): Promise<string> {
  const { acquireChromium } = await import("./acquisition.ts");
  return acquireChromium({ ...options, dataDir });
}
