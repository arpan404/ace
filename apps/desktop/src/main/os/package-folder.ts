import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** `kHasBundle` in the Finder flags of a folder's `com.apple.FinderInfo`. */
const hasBundle = 0x2000;

/** Whether the Finder flags (bytes 8-9 of `com.apple.FinderInfo`) mark a package. */
export function finderFlagsMarkPackage(finderInfo: Uint8Array): boolean {
  if (finderInfo.length < 10) return false;
  const flags = ((finderInfo[8] ?? 0) << 8) | (finderInfo[9] ?? 0);
  return (flags & hasBundle) !== 0;
}

/**
 * Whether macOS treats this folder as a single item: it has a bundle's `Contents/Info.plist`
 * or its Finder bundle bit is set. Other platforms have no packages.
 */
export function isPackageFolder(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== "darwin") return false;
  if (existsSync(join(path, "Contents", "Info.plist"))) return true;
  try {
    const hex = execFileSync("/usr/bin/xattr", ["-px", "com.apple.FinderInfo", path], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return finderFlagsMarkPackage(Buffer.from(hex.replace(/\s+/g, ""), "hex"));
  } catch {
    // No Finder info: an ordinary folder.
    return false;
  }
}
