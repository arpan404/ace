import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { FileIdentitySchema } from "./file-identity.ts";
import { DIRECTORY_CAP } from "./types.ts";

const require = createRequire(import.meta.url);
const PosixBinding = z.object({
  pipe: z.function({
    input: [],
    output: z.object({
      read: z.number().int().nonnegative(),
      write: z.number().int().nonnegative(),
    }),
  }),
  openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
  openAt: z.function({
    input: [z.number().int(), z.string(), z.number().int()],
    output: z.number().int().nonnegative(),
  }),
  openMetadataAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.number().int().nonnegative(),
  }),
  chmodMetadata: z.function({
    input: [z.number().int().nonnegative(), z.number().int().min(0).max(0o777)],
    output: z.void(),
  }),
  unlinkAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  removeDirectoryAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  renameAt: z.function({ input: [z.number().int(), z.string(), z.string()], output: z.void() }),
  mkdirAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
  statAt: z.function({
    input: [z.number().int(), z.string()],
    output: z.object({
      dev: z.number(),
      ino: z.number(),
      identity: FileIdentitySchema,
      mode: z.number().int(),
      size: z.number(),
      mtime: z.number(),
    }),
  }),
  names: z.function({
    input: [z.number().int(), z.number().int()],
    output: z.array(z.string()).max(DIRECTORY_CAP),
  }),
});
let loaded: z.infer<typeof PosixBinding> | undefined;
export function posixBinding(): z.infer<typeof PosixBinding> {
  // Importing the shared service API needs no native addon. Filesystem operations load it on demand.
  if (!loaded) {
    let native: unknown;
    try {
      native = require("../dist/descriptor.node");
    } catch (error) {
      if (
        !process.versions.electron ||
        !(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")
      )
        throw error;
      native = require(
        join(
          z.object({ resourcesPath: z.string().min(1) }).parse(process).resourcesPath,
          "daemon/descriptor.node",
        ),
      );
    }
    loaded = PosixBinding.parse(native);
  }
  return loaded;
}
