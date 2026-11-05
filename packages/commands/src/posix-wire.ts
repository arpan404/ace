import { z } from "zod";

const fd = z.number().int();
const name = z.string().min(1).max(4096);
const flags = z.number().int();

/** One descriptor-relative call for the POSIX worker. Names are single path components. */
export const PosixOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("open"), directory: fd, name, flags }),
  z.object({ op: z.literal("create"), directory: fd, name, flags }),
  z.object({ op: z.literal("openDirectory"), fd }),
  z.object({ op: z.literal("readDirectory"), reader: z.number().int().positive() }),
  z.object({ op: z.literal("closeDirectory"), reader: z.number().int().positive() }),
  // Closes a descriptor this worker opened for a caller who gave up before it answered.
  z.object({ op: z.literal("closeFd"), fd: z.number().int().nonnegative() }),
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

/**
 * Integer results are the call's own return value (negative on failure). `openDirectory`
 * returns a reader id (0 when fdopendir failed), `readDirectory` an entry name or null at the
 * end, `readLink` the link text or null.
 */
export const PosixReply = z.discriminatedUnion("ok", [
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(true),
    value: z.union([z.number().int(), z.string(), z.null()]),
  }),
  z.object({ id: z.number().int().positive(), ok: z.literal(false), message: z.string() }),
]);
export type PosixReply = z.infer<typeof PosixReply>;
