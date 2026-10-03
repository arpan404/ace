import { cp, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ReleaseTarget } from "@ace/protocol";
import { hashFile } from "@ace/service";

export const LinuxNativeInput = z.object({
  pty: z.string().min(1),
  ptySha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Linux uses forkpty; the spawn helper is built and used only on macOS. */
export async function stageNativeFiles(
  target: string,
  prebuild: string,
  destination: string,
  input?: unknown,
): Promise<void> {
  const platform = ReleaseTarget.parse(target);
  await mkdir(destination, { recursive: true });
  if (platform === "linux-x64" || platform === "linux-arm64") {
    const native = LinuxNativeInput.parse(input);
    if ((await hashFile(native.pty)) !== native.ptySha256)
      throw new Error("Native input checksum mismatch");
    await cp(native.pty, join(destination, "pty.node"));
    return;
  }
  await cp(join(prebuild, "pty.node"), join(destination, "pty.node"));
  await cp(join(prebuild, "spawn-helper"), join(destination, "spawn-helper"));
  await chmod(join(destination, "spawn-helper"), 0o755);
}
