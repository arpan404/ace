import { readFileRange, sendResumableUpload, Sha256 } from "@ace/client";
import type { ThreadId } from "@ace/protocol";
import { CheckoutError, checkoutError, fromCode, isCheckoutPath } from "@ace/ui-core";
import type { FilesOwner } from "./checkout-files.ts";
import { Stat } from "./checkout-request.ts";

/*
 * A save of one part of a file too large to edit whole (`checkout-pages.ts` reads the parts).
 * The phone holds only that part: the new file is the old bytes before it, the part's new text,
 * and the old bytes after it, read from the daemon at the version the part was opened at and
 * sent through a resumable upload pinned to that version. The bytes go through twice, once to
 * hash them (an upload names its hash first) and once to send, a chunk at a time, so a save
 * costs a chunk of memory however large the file is.
 */

/** The largest file a part can be saved into: the daemon's upload limit. */
export const partFileLimit = 64 * 1024 * 1024;
/** Bytes per upload chunk (the upload's own limit). */
const chunk = 64 * 1024;

/** One piece of the new file: a range of the old file's bytes, or the part's new bytes. */
export type Piece = { kind: "old"; from: number; to: number } | { kind: "new"; bytes: Uint8Array };

/**
 * The new file as pieces, when the part at `offset` (`length` bytes of the old file, `size`
 * bytes long) is replaced. Null when the part isn't inside the file.
 */
export function partPieces(
  size: number,
  offset: number,
  length: number,
  replacement: Uint8Array,
): Piece[] | null {
  if (offset < 0 || length < 0 || offset + length > size) return null;
  const pieces: Piece[] = [];
  if (offset > 0) pieces.push({ kind: "old", from: 0, to: offset });
  if (replacement.length > 0) pieces.push({ kind: "new", bytes: replacement });
  if (offset + length < size) pieces.push({ kind: "old", from: offset + length, to: size });
  return pieces;
}

const pieceLength = (piece: Piece) =>
  piece.kind === "new" ? piece.bytes.length : piece.to - piece.from;

export interface PartEdit {
  path: string;
  /** Where the part starts in the file, in bytes, and how many bytes of it the part held. */
  offset: number;
  length: number;
  /** The part's text after editing. */
  text: string;
  /** The file's version the part was read at. */
  version: string;
}

/** The new file's bytes from `from` on, in chunks no larger than an upload's. */
async function* newBytes(
  owner: FilesOwner,
  threadId: ThreadId,
  edit: PartEdit,
  pieces: readonly Piece[],
  from: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let start = 0;
  for (const piece of pieces) {
    const end = start + pieceLength(piece);
    if (end > from) {
      const skip = Math.max(0, from - start);
      if (piece.kind === "new") {
        for (let at = skip; at < piece.bytes.length; at += chunk)
          yield piece.bytes.subarray(at, Math.min(piece.bytes.length, at + chunk));
      } else {
        yield* oldBytes(owner, threadId, edit, piece.from + skip, piece.to, signal);
      }
    }
    start = end;
  }
}

/** The old file's bytes in `[from, to)`, read at the edit's version. */
async function* oldBytes(
  owner: FilesOwner,
  threadId: ThreadId,
  edit: PartEdit,
  from: number,
  to: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for (let at = from; at < to;) {
    const read = await readAt(owner, threadId, edit, at, signal);
    const bytes = read.bytes.subarray(0, Math.min(read.bytes.length, to - at));
    if (bytes.length === 0) throw changed();
    for (let part = 0; part < bytes.length; part += chunk)
      yield bytes.subarray(part, Math.min(bytes.length, part + chunk));
    at += bytes.length;
  }
}

const changed = () =>
  new CheckoutError("changed", "The file changed since you opened this part. Open it again.");

async function readAt(
  owner: FilesOwner,
  threadId: ThreadId,
  edit: PartEdit,
  offset: number,
  signal: AbortSignal,
) {
  const read = await readFileRange(
    owner,
    { threadId, path: edit.path, offset, validator: edit.version },
    { signal, timeoutMs: 30_000 },
  ).catch((error: unknown) => {
    const parsed = checkoutError(error);
    throw parsed.code === "CONFLICT" ? changed() : parsed;
  });
  if (read.kind !== "file") throw new CheckoutError("missing", "Nothing is at this path any more.");
  return { bytes: read.bytes, size: read.size ?? 0 };
}

/**
 * Save `edit` over the part it was read from: the file's new version, or the version that
 * replaced the one the part was read at (the person decides then, as with a whole-file save).
 */
export async function writePart(
  owner: FilesOwner,
  threadId: ThreadId,
  edit: PartEdit,
  signal: AbortSignal,
): Promise<{ version: string } | { conflict: string }> {
  if (!isCheckoutPath(edit.path)) throw fromCode("OUTSIDE_WORKSPACE");
  let size: number;
  try {
    size = (await readAt(owner, threadId, edit, 0, signal)).size;
    await assertTextPart(owner, threadId, edit, signal);
  } catch (error) {
    if (!(error instanceof CheckoutError) || error.code !== "changed") throw error;
    return { conflict: await currentVersion(owner, threadId, edit.path, signal) };
  }
  const replacement = new TextEncoder().encode(edit.text);
  const pieces = partPieces(size, edit.offset, edit.length, replacement);
  if (!pieces) throw changed();
  const total = pieces.reduce((sum, piece) => sum + pieceLength(piece), 0);
  if (total > partFileLimit)
    throw new CheckoutError("too_large", "Files over 64 MB can't be saved from the phone.");
  const hash = new Sha256();
  for await (const bytes of newBytes(owner, threadId, edit, pieces, 0, signal)) hash.update(bytes);
  try {
    const value = await sendResumableUpload(
      owner,
      {
        input: {
          threadId,
          path: edit.path,
          expected: edit.version,
          size: total,
          sha256: hash.hex(),
        },
        source: (from) => newBytes(owner, threadId, edit, pieces, from, signal),
      },
      { signal, timeoutMs: 60_000 },
    );
    // The commit's file change; only its new version matters here.
    const saved = Stat.parse(value);
    if (!saved.version)
      throw new CheckoutError(
        "unconfirmed",
        "Couldn't confirm the saved file. Refresh to check it.",
      );
    return { version: saved.version };
  } catch (error) {
    const code = error instanceof CheckoutError ? error.code : checkoutError(error).code;
    if (code !== "CONFLICT" && code !== "changed") throw error;
    return { conflict: await currentVersion(owner, threadId, edit.path, signal) };
  }
}

/**
 * The part's old bytes are UTF-8 that its text gives back exactly. Bytes that aren't (a stray
 * byte, another encoding) were shown with replacement characters, and saving that text would
 * change bytes the person never touched, so such a part is never saved.
 */
async function assertTextPart(
  owner: FilesOwner,
  threadId: ThreadId,
  edit: PartEdit,
  signal: AbortSignal,
): Promise<void> {
  const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const parts: Uint8Array[] = [];
  for await (const bytes of oldBytes(
    owner,
    threadId,
    edit,
    edit.offset,
    edit.offset + edit.length,
    signal,
  ))
    parts.push(bytes);
  const whole = new Uint8Array(edit.length);
  let at = 0;
  for (const bytes of parts) {
    whole.set(bytes, at);
    at += bytes.length;
  }
  try {
    strict.decode(whole);
  } catch {
    throw new CheckoutError(
      "not_utf8",
      "This part isn't plain UTF-8 text, so the phone can't save it without changing other bytes.",
    );
  }
}

async function currentVersion(
  owner: FilesOwner,
  threadId: ThreadId,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const reply = await owner.request(
    { type: "files.request", threadId, operation: { op: "stat", path } },
    { signal, timeoutMs: 20_000 },
  );
  const version = reply.type === "files.result" ? Stat.parse(reply.value).version : null;
  if (!version)
    throw new CheckoutError(
      "deleted",
      "This file was deleted. Copy your edits, then create a new file.",
    );
  return version;
}
