import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScreenEndpoint } from "@ace/protocol";

export type FrameEndpoint = {
  uri: string;
  path: string;
  secure(): Promise<void>;
  close(): Promise<void>;
};
/** Executable paths never use this temporary directory; it contains only owner-private IPC. */
export async function localFrameEndpoint(
  platform: NodeJS.Platform,
  nextId: () => string,
): Promise<FrameEndpoint> {
  if (platform === "win32") {
    // Node cannot promise an owner-only Windows DACL. Require the platform factory.
    throw new Error(`Owner-only Windows pipe factory required (ace-screen-${nextId()})`);
  }
  const directory = await mkdtemp(join(tmpdir(), "ace-screen-"));
  await chmod(directory, 0o700);
  const path = join(directory, "frames.sock");
  try {
    return {
      uri: ScreenEndpoint.parse(`unix:${path}`),
      path,
      secure: () => chmod(path, 0o600),
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
