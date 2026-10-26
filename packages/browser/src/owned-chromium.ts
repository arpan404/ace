/** Chrome for Testing has no Windows ARM64 artifact. Use the person's installed
 * Chrome or Edge executable with ace's own profile on that platform.
 */
export async function ownedChromium(
  platform: NodeJS.Platform,
  arch: string,
  sources: {
    installed(): Promise<string | undefined>;
    acquire(): Promise<string>;
  },
): Promise<string> {
  if (platform !== "win32" || arch !== "arm64") return sources.acquire();
  const installed = await sources.installed();
  if (installed) return installed;
  throw new Error("Install Chrome or Microsoft Edge to use ace's browser on Windows ARM64");
}
