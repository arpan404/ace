import { findAndroidTools } from "@ace/devices/android-tools";
import { findExecutable } from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import type { Toolchain } from "@ace/protocol";

type Run = (command: string, args: string[]) => Promise<string | undefined>;

/** "Xcode 26.0\nBuild version 17A324" → "26.0". */
function xcodeVersion(output: string | undefined): string | undefined {
  return output && /^Xcode\s+(\d[\w.]*)/.exec(output)?.[1]?.slice(0, 64);
}
/** The platform-tools release `adb version` reports ("Version 35.0.2-12147458" → "35.0.2"). */
function adbToolsVersion(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match =
    /^Version\s+(\d+(?:\.\d+)+)/m.exec(output) ?? /version\s+(\d+(?:\.\d+)+)/i.exec(output);
  return match?.[1]?.slice(0, 64);
}

/**
 * Tools ace uses but never bundles: git (workspaces, review), Xcode (iOS Simulator) and the
 * Android tools (adb for phones, network devices and emulators). Missing tools get a setup hint
 * instead of an error.
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
    const version = xcode ? xcodeVersion(await exec("xcodebuild", ["-version"])) : undefined;
    result.push({
      id: "xcode",
      available: Boolean(xcode),
      detail: xcode ? `Xcode at ${developer ?? "unknown path"}` : "Simulator tools not found",
      hint: "Install Xcode from the App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app",
      ...(version ? { version } : {}),
    });
  }
  // The adb the devices service runs: an SDK's platform-tools, else the one on PATH.
  const installed = await findAndroidTools({ env, home: env.HOME ?? env.USERPROFILE });
  const configured = Boolean(env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT);
  const adb = installed.adb ?? (configured ? undefined : "adb");
  const adbVersion = adb ? await exec(adb, ["version"]) : undefined;
  const platformTools = adbToolsVersion(adbVersion);
  result.push({
    id: "android",
    available: Boolean(adbVersion),
    detail: adbVersion?.split("\n")[0] ?? "adb not found",
    hint:
      platform === "linux"
        ? "Optional: install your distribution's adb (Debian/Ubuntu: sudo apt install adb) for Android phones and network devices, or Android Studio with ANDROID_HOME set to its SDK directory for emulators too."
        : "Optional: install Android Studio, then set ANDROID_HOME to its SDK directory.",
    ...(platformTools ? { version: platformTools } : {}),
  });
  return result;
}
