import { z } from "zod";

/**
 * A handle names a descriptor or directory stream that one worker owns. The main thread
 * allocates handle ids and never reuses one; the descriptor number behind it never leaves the
 * worker. `-100` (AT_FDCWD) is allowed only where an absolute name is opened.
 */
const handle = z.number().int().positive();
const directory = z.union([handle, z.literal(-100)]);
const name = z.string().min(1).max(4096);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"));
const flags = z.number().int();
/** null reads or writes at the descriptor's own offset, as Node's `read` does. */
const position = z.number().int().nonnegative().nullable();
/** One read or write moves at most this many bytes. */
export const posixChunkLimit = 1024 * 1024;

/** One call for a POSIX worker. Names are single path components; paths are absolute. */
export const PosixOperation = z.discriminatedUnion("op", [
  // Opening calls store their result under the new `handle`; they answer 0, or -1 on failure.
  z.object({ op: z.literal("open"), directory, name, flags, handle }),
  z.object({ op: z.literal("create"), directory: handle, name, flags, handle }),
  // `path` opened from `/` one component at a time, never following a link.
  z.object({ op: z.literal("openPath"), path, handle }),
  // Takes `fd` over: the stream owns its descriptor, and a failed fdopendir closes it. 1 or 0.
  z.object({ op: z.literal("openDirectory"), fd: handle, stream: handle }),
  z.object({ op: z.literal("readDirectory"), reader: handle }),
  z.object({ op: z.literal("close"), handle }),
  z.object({ op: z.literal("fstat"), fd: handle }),
  z.object({
    op: z.literal("read"),
    fd: handle,
    length: z.number().int().positive().max(posixChunkLimit),
    position,
  }),
  z.object({
    op: z.literal("write"),
    fd: handle,
    data: z.instanceof(Uint8Array).refine((data) => data.length <= posixChunkLimit),
    position,
  }),
  z.object({ op: z.literal("fsync"), fd: handle }),
  z.object({ op: z.literal("chmod"), fd: handle, mode: flags }),
  z.object({ op: z.literal("readLink"), directory: handle, name }),
  z.object({ op: z.literal("mkdir"), directory: handle, name, mode: flags }),
  z.object({ op: z.literal("unlink"), directory: handle, name, flags }),
  z.object({ op: z.literal("symlink"), target: name, directory: handle, name }),
  z.object({
    op: z.enum(["rename", "link", "renameFlags"]),
    from: handle,
    fromName: name,
    to: handle,
    toName: name,
    flags,
  }),
  // Path calls on a command root, so they too run on the root's thread.
  z.object({ op: z.literal("lstatPath"), path }),
  z.object({ op: z.literal("statPath"), path }),
  z.object({ op: z.literal("realpath"), path }),
  z.object({ op: z.literal("readdirPath"), path, limit: z.number().int().positive().max(65536) }),
  z.object({ op: z.literal("mkdirPath"), path }),
  // A whole file, refusing a final symlink and anything over `limit` bytes.
  z.object({
    op: z.literal("readPathNoFollow"),
    path,
    limit: z.number().int().positive().max(posixChunkLimit),
  }),
]);
export type PosixOperation = z.infer<typeof PosixOperation>;

export const PosixRequest = z.object({
  id: z.number().int().positive(),
  operation: PosixOperation,
});

/** Sent once nothing more will be: after the current call returns, close everything and exit. */
export const PosixDrain = z.object({ drain: z.literal(true) });

/** The fields of a stat that command discovery and the skill library read. */
export const PosixStat = z.object({
  dev: z.number(),
  ino: z.number(),
  mode: z.number().int(),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
});
export type PosixStat = z.infer<typeof PosixStat>;

/**
 * Integer results are the call's own return value (negative on failure); see each call above.
 * `readDirectory` answers an entry name or null at the end, `readLink` the link text or null,
 * `read` and `readPathNoFollow` bytes, stat calls the stat fields, `readdirPath` names and
 * `realpath` the path. Calls that throw answer the error's message and code.
 */
export const PosixReply = z.discriminatedUnion("ok", [
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(true),
    value: z.union([
      z.number().int(),
      z.string(),
      z.null(),
      z.instanceof(Uint8Array),
      PosixStat,
      z.array(z.string()),
    ]),
  }),
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(false),
    message: z.string(),
    code: z.string().optional(),
  }),
]);
export type PosixReply = z.infer<typeof PosixReply>;
export type PosixValue = Extract<PosixReply, { ok: true }>["value"];
