import { appendFileSync } from "node:fs";
import { z } from "zod";
import { chromiumArtifact, detectChromium, installChromium } from "@ace/browser";

// CI owns the downloaded runtime and every test profile. Reuse acquisition's
// pinned publisher/checksum contract instead of maintaining another downloader.
if (process.platform !== "win32") throw new Error("Windows browser preparation requires Windows");
const env = z
  .object({ RUNNER_TEMP: z.string().min(1), GITHUB_ENV: z.string().min(1) })
  .parse(process.env);
let executable = await detectChromium();
if (!executable) {
  // Chrome for Testing publishes win64, not Windows ARM64. Its x64 browser
  // runs under emulation on ARM; Node and the screen helper stay native.
  executable = await installChromium(env.RUNNER_TEMP, {
    artifact: chromiumArtifact("win32", "x64"),
  });
}
if (/[\r\n]/.test(executable)) throw new Error("Invalid Chromium executable path");
appendFileSync(env.GITHUB_ENV, `ACE_CHROMIUM_PATH=${executable}\n`);
console.log(JSON.stringify({ browserExecutable: executable, nativeNodeArch: process.arch }));
