import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { FileIdentitySchema, Win32FileIdentitySchema } from "./file-identity.ts";
import { DIRECTORY_CAP } from "./types.ts";

const require = createRequire(import.meta.url);
function loadNativeAddon(): unknown {
  try {
    return require("../dist/descriptor.node");
  } catch (error) {
    if (
      !process.versions.electron ||
      !(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")
    )
      throw error;
    return require(
      join(
        z.object({ resourcesPath: z.string().min(1) }).parse(process).resourcesPath,
        "daemon/descriptor.node",
      ),
    );
  }
}
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
    loaded = PosixBinding.parse(loadNativeAddon());
  }
  return loaded;
}

const WindowsIdentity = Win32FileIdentitySchema.omit({ kind: true }).strict();
const WindowsMetadata = WindowsIdentity.extend({
  mode: z.number().int().min(0).max(0o177777),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  attrs: z.number().int().nonnegative().max(0xffffffff),
}).strict();
const WindowsBinding = z
  .object({
    openRoot: z.function({ input: [z.string()], output: z.number().int().nonnegative() }),
    openDirectoryAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    openFileAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    openMetadataAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    openPrivateMetadataAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    createFileAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    createPrivateFileAt: z.function({
      input: [z.number().int(), z.string()],
      output: z.number().int().nonnegative(),
    }),
    mkdirAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    unlinkAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    removeDirectoryAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    renameAt: z.function({
      input: [z.number().int(), z.string(), z.string()],
      output: z.void(),
    }),
    renameExclusiveAt: z.function({
      input: [z.number().int(), z.string(), z.string()],
      output: z.void(),
    }),
    securePrivateFd: z.function({ input: [z.number().int()], output: z.void() }),
    checkPrivateFd: z.function({ input: [z.number().int()], output: z.void() }),
    checkPrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    securePrivateAt: z.function({ input: [z.number().int(), z.string()], output: z.void() }),
    statFd: z.function({ input: [z.number().int()], output: WindowsMetadata }),
    statAt: z.function({ input: [z.number().int(), z.string()], output: WindowsMetadata }),
    identityOf: z.function({ input: [z.number().int()], output: WindowsIdentity }),
    names: z.function({
      input: [z.number().int(), z.number().int()],
      output: z.array(z.string()).max(DIRECTORY_CAP),
    }),
  })
  .strict();
export function parseWindowsBinding(native: unknown): z.infer<typeof WindowsBinding> {
  return WindowsBinding.parse(native);
}
let loadedWindows: z.infer<typeof WindowsBinding> | undefined;
export function windowsBinding(): z.infer<typeof WindowsBinding> {
  if (!loadedWindows) {
    loadedWindows = parseWindowsBinding(loadNativeAddon());
  }
  return loadedWindows;
}
