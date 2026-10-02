import { createHash } from "node:crypto";
import { createWriteStream, constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { withDirectoryLock } from "./lock.ts";
import { PluginHash } from "@ace/protocol/plugins";
import { limits, normalizePath } from "./manifest.ts";
import {
  assertNoSymlinks,
  assertTreeNoSymlinks,
  isMissing,
  ownDirectory,
  writeContained,
} from "./files.ts";
import type { PluginProjection } from "./types.ts";

const fileSchema = z
  .strictObject({
    path: z.string(),
    executable: z.boolean(),
    content: z.string().max(limits.file).optional(),
    source: z.strictObject({ path: z.string(), hash: PluginHash }).optional(),
  })
  .refine(
    (file) => (file.content === undefined) !== (file.source === undefined),
    "File needs exactly one content or source",
  );
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
async function recover(root: string): Promise<void> {
  for (const path of ["generated", ".ace-writing", ".ace-previous"])
    await assertNoSymlinks(join(root, path));
  for (const path of ["generated", ".ace-previous", ".ace-writing"])
    await assertTreeNoSymlinks(join(root, path));
  const previous = join(root, ".ace-previous");
  const generated = join(root, "generated");
  if (await exists(previous)) {
    if (await exists(generated)) await rm(previous, { recursive: true });
    else await rename(previous, generated);
  }
  await rm(join(root, ".ace-writing"), { recursive: true, force: true });
}
/** Replace only an owned generated tree, after fully writing and verifying its replacement. */
export async function materializeProjection(
  projection: PluginProjection,
  options: { root: string },
): Promise<void> {
  const root = await ownDirectory(options.root);
  await withDirectoryLock(root, async () => {
    const stage = join(root, ".ace-writing");
    try {
      await recover(root);
      await mkdir(stage, { mode: 0o700 });
      const paths = new Set<string>();
      let total = 0;
      if (projection.files.length > limits.files * 3) throw new Error("Projection file limit");
      for (const raw of projection.files) {
        const file = fileSchema.parse(raw);
        const fullPath = normalizePath(file.path);
        if (!fullPath.startsWith("generated/"))
          throw new Error("Projection path outside generated tree");
        const path = normalizePath(fullPath.slice(10));
        if (paths.has(path)) throw new Error("Duplicate projection path");
        paths.add(path);
        if (file.content !== undefined) {
          total += Buffer.byteLength(file.content);
          if (total > limits.total * 3) throw new Error("Projection byte limit");
          await writeContained(stage, path, file.content, file.executable);
        } else if (file.source) {
          await assertNoSymlinks(file.source.path);
          const target = join(stage, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          const digest = createHash("sha256");
          let bytes = 0;
          const verifier = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              total += chunk.length;
              if (bytes > limits.file || total > limits.total * 3) {
                callback(new Error("Projection byte limit"));
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
          });
          const source = await open(file.source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await pipeline(
              source.createReadStream({ highWaterMark: 64 * 1024, autoClose: false }),
              verifier,
              createWriteStream(target, { flags: "wx", mode: file.executable ? 0o700 : 0o600 }),
            );
          } finally {
            await source.close();
          }
          if (digest.digest("hex") !== file.source.hash)
            throw new Error("Integrity mismatch during projection");
        }
      }
      const generated = join(root, "generated");
      const previous = join(root, ".ace-previous");
      if (await exists(generated)) await rename(generated, previous);
      await rename(stage, generated);
      await rm(previous, { recursive: true, force: true });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
}
export async function removeProjection(directory: string): Promise<void> {
  const root = await ownDirectory(directory);
  await withDirectoryLock(root, async () => {
    await recover(root);
    await rm(join(root, "generated"), { recursive: true, force: true });
  });
}
