import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const Manifest = z.object({
  name: z.literal("@earendil-works/pi-coding-agent"),
  version: z.enum(["0.85.1", "1.1.0"]),
  main: z.literal("./dist/index.js"),
});

/** Bind auth to the SDK shipped with the selected executable, never an ace-installed copy. */
export async function piLoginRuntime(command: string, version?: string): Promise<string> {
  if (version !== "1.1.0" && version !== "0.85.1")
    throw new Error("Pi login requires the reviewed SDK version");
  let directory = dirname(await realpath(command));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const file = await open(
        join(directory, "package.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let data: string;
      try {
        if (!(await file.stat()).isFile()) throw new Error("Package metadata must be a file");
        const buffer = Buffer.alloc(65537);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 65536) throw new Error("Package metadata is too large");
        data = buffer.toString("utf8", 0, bytesRead);
      } finally {
        await file.close();
      }
      const manifest = Manifest.parse(JSON.parse(data));
      if (manifest.version !== version) throw new Error("Pi SDK version mismatch");
      return pathToFileURL(join(directory, manifest.main)).href;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("The installed Pi SDK is unavailable");
}
