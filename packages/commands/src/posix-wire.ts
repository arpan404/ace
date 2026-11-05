import { z } from "zod";

const fd = z.number().int();
const name = z.string().min(1).max(4096);
const flags = z.number().int();
const open = z.number().int().nonnegative();
/** null reads or writes at the descriptor's own offset, as Node's `read` does. */
const position = z.number().int().nonnegative().nullable();
/** One read or write moves at most this many bytes. */
export const posixChunkLimit = 1024 * 1024;

/** One descriptor-relative call for the POSIX worker. Names are single path components. */
export const PosixOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), directory: fd, name, flags }),
  z.object({ op: z.literal("create"), directory: fd, name, flags }),
  z.object({ op: z.literal("openDirectory"), fd }),
  z.object({ op: z.literal("readDirectory"), reader: z.number().int().positive() }),
  z.object({ op: z.literal("closeDirectory"), reader: z.number().int().positive() }),
  z.object({ op: z.literal("closeFd"), fd: open }),
  z.object({ op: z.literal("fstat"), fd: open }),
  z.object({
    op: z.literal("read"),
    fd: open,
    length: z.number().int().positive().max(posixChunkLimit),
    position,
  }),
  z.object({
    op: z.literal("write"),
    fd: open,
    data: z.instanceof(Uint8Array).refine((data) => data.length <= posixChunkLimit),
    position,
  }),
  z.object({ op: z.literal("fsync"), fd: open }),
  z.object({ op: z.literal("chmod"), fd: open, mode: flags }),
  z.object({ op: z.literal("readLink"), directory: fd, name }),
  z.object({ op: z.literal("mkdir"), directory: fd, name, mode: flags }),
  z.object({ op: z.literal("unlink"), directory: fd, name, flags }),
  z.object({ op: z.literal("symlink"), target: name, directory: fd, name }),
  z.object({
    op: z.enum(["rename", "link", "renameFlags"]),
    from: fd,
    fromName: name,
    to: fd,
    toName: name,
    flags,
  }),
]);
export type PosixOperation = z.infer<typeof PosixOperation>;

export const PosixRequest = z.object({
  id: z.number().int().positive(),
  operation: PosixOperation,
});

/**
 * Sent after the worker's last call: once that call returns, close what it opened when it is
 * `abandoned`, close every directory stream, and exit.
 */
export const PosixDrain = z.object({
  drain: z.literal(true),
  abandoned: z.number().int().positive().optional(),
});

/** The fields of fstat that command discovery and the skill library read. */
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
 * Integer results are the call's own return value (negative on failure). `openDirectory`
 * returns a reader id (0 when fdopendir failed), `readDirectory` an entry name or null at the
 * end, `readLink` the link text or null, `read` the bytes read and `fstat` the stat fields.
 * fstat, read, write, fsync and chmod fail with the error's message instead.
 */
export const PosixReply = z.discriminatedUnion("ok", [
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(true),
    value: z.union([z.number().int(), z.string(), z.null(), z.instanceof(Uint8Array), PosixStat]),
  }),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), message: z.string() }),
]);
export type PosixReply = z.infer<typeof PosixReply>;
export type PosixValue = Extract<PosixReply, { ok: true }>["value"];
