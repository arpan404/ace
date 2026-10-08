import { existsSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import type { Toolchain } from "@ace/protocol";

type Run = (command: string, args: string[]) => Promise<string | undefined>;

/**
 * Tools ace uses but never bundles: git (workspaces, review), Xcode (iOS Simulator) and the
 * Android SDK (emulators). Missing tools get a setup hint instead of an error.
 */
export async function detectToolchains(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exec: Run = async (command, args) => {
    try {
      const result = await probeOutput(command, args, { env, timeoutMs: 5000, maxBytes: 4096 });
      return result.code === 0 ? result.stdout.trim().slice(0, 2048) : undefined;
    } catch {
      return undefined;
    }
  },
): Promise<Toolchain[]> {
  const gitPath = await findExecutable("git", env);
  const git = gitPath ? await exec(gitPath, ["--version"]) : undefined;
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
