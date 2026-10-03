import { z } from "zod";
/** Google Chrome for Testing object metadata, pinned with Playwright 1.61.1.
 * MD5 checks transfer integrity; HTTPS and immutable generation pin the publisher.
 * https://storage.googleapis.com/storage/v1/b/chrome-for-testing-public/o/<encoded object>
 */
export const ChromiumArtifact = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/),
  url: z.url(),
  checksum: z.string().regex(/^[a-f0-9]{32}$/),
  executable: z.string().min(1).max(512),
});
export type ChromiumArtifact = z.infer<typeof ChromiumArtifact>;
const version = "153.0.8010.12";
const artifacts = {
  linux64: ["jZzsnTCZ7NfoJuQp7GY8qQ==", "1787696957613313", "chrome-linux64/chrome"],
  "mac-arm64": [
    "tqjGccJBGrRav/OCALeFXA==",
    "1787699213503949",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  "mac-x64": [
    "xXnZBj5LF4gPG5/RNzLpIg==",
    "1787704250829772",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  win64: ["ei09b8SO4hncRZArhJPUAQ==", "1787703838651479", "chrome-win64/chrome.exe"],
} as const;
export function chromiumArtifact(platform: NodeJS.Platform, arch: string): ChromiumArtifact {
  const key =
    platform === "darwin"
      ? arch === "arm64"
        ? "mac-arm64"
        : arch === "x64"
          ? "mac-x64"
          : undefined
      : platform === "linux" && arch === "x64"
        ? "linux64"
        : platform === "win32" && arch === "x64"
          ? "win64"
          : undefined;
  if (!key) throw new Error("No pinned ace Chromium for this platform; use the desktop backend");
  const [checksum, generation, executable] = artifacts[key];
  return ChromiumArtifact.parse({
    version,
    checksum: Buffer.from(checksum, "base64").toString("hex"),
    executable,
    url: `https://storage.googleapis.com/download/storage/v1/b/chrome-for-testing-public/o/${encodeURIComponent(`${version}/${key}/chrome-${key}.zip`)}?generation=${generation}&alt=media`,
  });
}
