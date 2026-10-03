import { createRequire } from "node:module";
import { open, access } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";

export type SdkInstallation = {
  installed: boolean;
  supported: boolean;
  module?: string;
  version?: string;
  error?: string;
};
const manifest = z.object({ name: z.string().max(256), version: z.string().max(256) });
async function readManifest(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(65537);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    if (bytes > 65536) throw new Error("SDK manifest exceeds admission budget");
    return buffer.toString("utf8", 0, bytes);
  } finally {
    await file.close();
  }
}
export interface SdkDiscoveryOptions {
  resolve?: (id: string) => string;
  read?: (path: string) => Promise<string>;
  executable?: (path: string) => Promise<void>;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
}
/** Resolve without importing the SDK into the daemon's credential-cache domain. */
export async function discoverSdk(
  name: string,
  version: string,
  options: SdkDiscoveryOptions = {},
): Promise<SdkInstallation> {
  const resolve = options.resolve ?? createRequire(import.meta.url).resolve;
  const read = options.read ?? readManifest;
  let module: string;
  try {
    module = resolve(name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")
      return { installed: false, supported: false };
    return { installed: true, supported: false, error: "SDK resolution failed" };
  }
  try {
    let directory = dirname(module);
    let found: z.infer<typeof manifest> | undefined;
    for (let count = 0; count < 16 && directory !== parse(directory).root; count++) {
      try {
        const text = await read(join(directory, "package.json"));
        if (Buffer.byteLength(text) > 65536)
          throw new Error("SDK manifest exceeds admission budget");
        const candidate = manifest.parse(JSON.parse(text));
        if (candidate.name === name) {
          found = candidate;
          break;
        }
      } catch {
        /* The entry may sit inside nested build directories. */
      }
      directory = dirname(directory);
    }
    if (!found) throw new Error("SDK manifest missing");
    if (found.version !== version)
      return {
        installed: true,
        supported: false,
        module,
        version: found.version,
        error: `Install ${name} ${version}; resolved ${found.version}`,
      };
    const node = (options.nodeVersion ?? process.versions.node).split(".").map(Number);
    if (
      node.length !== 3 ||
      node.some((part) => !Number.isSafeInteger(part) || part < 0) ||
      (node[0] ?? 0) < 24
    )
      throw new Error("SDK host requires Node 24+");
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
      throw new Error(
        "Cursor SDK home/sandbox supervision is supported only on macOS/Linux arm64/x64; Windows needs Job Objects and home verification",
      );
    const helper = (options.resolve ?? createRequire(module).resolve)(
      `${name}-${platform}-${arch}/package.json`,
    );
    const helperText = await read(helper);
    if (Buffer.byteLength(helperText) > 65536)
      throw new Error("SDK helper manifest exceeds admission budget");
    const metadata = manifest.parse(JSON.parse(helperText));
    if (metadata.version !== version) throw new Error("SDK platform helper version mismatch");
    const executable = options.executable ?? ((path: string) => access(path, constants.X_OK));
    await executable(join(dirname(helper), "bin", "rg"));
    if (platform === "darwin") await executable(join(dirname(helper), "bin", "cursorsandbox"));
    // Linux sandbox helpers are admitted by the SDK during restricted setup.
    return { installed: true, supported: true, module, version };
  } catch (error) {
    return {
      installed: true,
      supported: false,
      module,
      version,
      error: error instanceof Error ? error.message : "SDK admission failed",
    };
  }
}
