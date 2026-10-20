import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { admitsVersion, requireReadableMinimum } from "../cli-requirements.ts";
import { probeOutput } from "../process.ts";

const Manifest = z.object({
  name: z.literal("@earendil-works/pi-coding-agent"),
  version: z.string().refine((value) => admitsVersion("pi", value)),
  main: z.literal("./dist/index.js"),
});

/** Bind auth to the SDK shipped with the selected executable, never an ace-installed copy. */
export async function piSdkEntry(command: string, version?: string): Promise<string> {
  requireReadableMinimum("pi", version);
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

/** Pi provider ids: also the choice and model-source ids ace uses for them. */
export const PiProviderId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const Listing = z.object({ providers: z.array(PiProviderId).max(256) });

/**
 * The providers Pi holds a saved credential for, from the installed SDK's own `listCredentials`:
 * ids only, never a secret. Undefined when this Pi can't say (an older SDK, or none found).
 */
export async function piCredentialProviders(
  command: string,
  options: {
    version?: string | undefined;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    probe?: typeof probeOutput | undefined;
  },
): Promise<readonly string[] | undefined> {
  try {
    const entry = await piSdkEntry(command, options.version);
    const output = await (options.probe ?? probeOutput)(
      process.execPath,
      [fileURLToPath(new URL("./pi-credentials-worker.ts", import.meta.url)), entry],
      {
        env: { ...options.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
        timeoutMs: options.timeoutMs ?? 4000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return output.code === 0 ? Listing.parse(JSON.parse(output.stdout)).providers : undefined;
  } catch {
    return undefined;
  }
}
