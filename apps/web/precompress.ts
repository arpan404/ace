import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** Smaller files are left to the daemon's on-the-fly compression. */
export const precompressMinBytes = 16 * 1024;
const compressible = new Set([".js", ".css", ".svg"]);

/** Whether a built file gets `.br` and `.gz` siblings: large hashed code, never source maps. */
export function precompressed(fileName: string, bytes: number): boolean {
  return (
    fileName.startsWith("assets/") &&
    compressible.has(extname(fileName)) &&
    bytes >= precompressMinBytes
  );
}

/**
 * Brotli (quality 11) and gzip (level 9) copies of the large built assets, written next to them
 * (ADR 0056). The daemon serves them when present (`apps/daemon/src/web-http.ts`), so the first
 * load after a daemon start no longer waits for a megabyte of JavaScript to compress, and the
 * copies are smaller than the daemon's quicker on-the-fly brotli. Both codings, because a
 * browser offers brotli only over HTTPS and a device on the local network reaches the daemon
 * over plain HTTP. The page itself changes with every build and is small; it stays on the fly.
 */
export function precompress(): Plugin {
  return {
    name: "ace:precompress",
    apply: "build",
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) return;
      await Promise.all(
        Object.values(bundle).map(async (output) => {
          const size =
            output.type === "chunk"
              ? Buffer.byteLength(output.code)
              : typeof output.source === "string"
                ? Buffer.byteLength(output.source)
                : output.source.byteLength;
          if (!precompressed(output.fileName, size)) return;
          const file = join(dir, output.fileName);
          const raw = await readFile(file);
          const [br, gz] = await Promise.all([
            brotli(raw, {
              params: {
                [constants.BROTLI_PARAM_QUALITY]: 11,
                [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
              },
            }),
            gzipped(raw, { level: 9 }),
          ]);
          await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
        }),
      );
    },
  };
}
