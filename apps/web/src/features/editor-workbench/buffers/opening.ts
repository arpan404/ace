import type { BufferStatus, DiskFile, Draft, Theirs } from "./types.ts";

/*
 * What a buffer becomes when it opens (or reopens after a reload), from the disk and the draft
 * kept on the device. Pure: the buffer does the I/O and applies the answer.
 */

export type Opening =
  | {
      kind: "text";
      /** The text the document starts with. */
      text: string;
      /** The disk version (and its text) the buffer is based on. */
      base: Theirs;
      dirty: boolean;
      /** The disk moved past the draft's base, or the file is gone. */
      clash?: { kind: "changed"; theirs: Theirs } | { kind: "deleted" };
      /** The stored draft matches the disk and can go. */
      dropDraft?: boolean;
    }
  | { kind: "status"; status: BufferStatus };

export type Read = { ok: true; file: DiskFile } | { ok: false; message: string };

export function opening(read: Read, draft: Draft | undefined): Opening {
  const drafted = draft && {
    kind: "text" as const,
    text: draft.text,
    base: { text: draft.original, version: draft.version },
    dirty: true,
  };
  // Offline with a draft: the person keeps reading and typing; a reconnect checks again.
  if (!read.ok)
    return drafted ?? { kind: "status", status: { kind: "failed", message: read.message } };
  const file = read.file;
  if (file.kind === "unreadable")
    return { kind: "status", status: { kind: "unreadable", reason: file.reason } };
  if (file.kind === "missing")
    return drafted
      ? { ...drafted, clash: { kind: "deleted" } }
      : { kind: "status", status: { kind: "missing" } };
  const disk = { text: file.text, version: file.version };
  if (!drafted) return { kind: "text", text: file.text, base: disk, dirty: false };
  if (drafted.base.version !== file.version)
    return { ...drafted, clash: { kind: "changed", theirs: disk } };
  const same = drafted.text === file.text;
  return { kind: "text", text: drafted.text, base: disk, dirty: !same, dropDraft: same };
}
