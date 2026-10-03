import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Toolchain } from "../../shared/onboarding.ts";

type Run = (command: string, args: string[]) => Promise<string | undefined>;

const run: Run = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, encoding: "utf8" }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    );
  });

/**
 * Tools ace uses but never bundles: git (workspaces, review), Xcode (iOS Simulator) and the
 * Android SDK (emulators). Missing tools get a setup hint instead of an error.
 */
export async function detectToolchains(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exec: Run = run,
): Promise<Toolchain[]> {
  const git = await exec("git", ["--version"]);
  const result: Toolchain[] = [
    {
      id: "git",
      available: Boolean(git),
      detail: git ?? "git was not found on PATH",
      hint:
        platform === "darwin"
          ? "Install the Xcode Command Line Tools: xcode-select --install"
          : "Install git with your package manager.",
    },
  ];
  if (platform === "darwin") {
    const xcode = await exec("xcrun", ["simctl", "help"]);
    const developer = await exec("xcode-select", ["-p"]);
    result.push({
      id: "xcode",
      available: Boolean(xcode),
      detail: xcode ? `Xcode at ${developer ?? "unknown path"}` : "Simulator tools not found",
      hint: "Install Xcode from the App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app",
    });
  }
  const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT;
  const adb = sdk ? join(sdk, "platform-tools", platform === "win32" ? "adb.exe" : "adb") : "adb";
  const adbVersion = sdk && !existsSync(adb) ? undefined : await exec(adb, ["version"]);
  result.push({
    id: "android",
    available: Boolean(adbVersion),
    detail: adbVersion?.split("\n")[0] ?? "Android SDK not found",
    hint: "Optional: install Android Studio, then set ANDROID_HOME to its SDK directory.",
  });
  return result;
}
