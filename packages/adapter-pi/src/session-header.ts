import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { PiHistoryError } from "./history-errors.ts";
const Path = z.string().min(1).max(8192).refine(isAbsolute, "Expected an absolute session path");
const Header = z.looseObject({
  type: z.literal("session"),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  id: z.string().min(1).max(128),
  cwd: Path,
});
export const SessionReference = z.object({ path: Path, id: z.string().min(1).max(128) });
export type SessionReference = z.infer<typeof SessionReference>;
export function encodeSessionReference(reference: SessionReference): string {
  return (
    "ace-pi:" + Buffer.from(JSON.stringify(SessionReference.parse(reference))).toString("base64url")
  );
}
export function decodeSessionReference(value: string): { path: string; id?: string } {
  if (!value.startsWith("ace-pi:")) return { path: Path.parse(value) };
  if (value.length > 16_384) throw new PiHistoryError("header");
  try {
    return SessionReference.parse(
      JSON.parse(Buffer.from(value.slice(7), "base64url").toString("utf8")),
    );
  } catch {
    throw new PiHistoryError("header");
  }
}
/** Header-only bounded I/O; never loads a transcript or edits native history. */
export async function readSessionHeader(path: string): Promise<z.infer<typeof Header>> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(Path.parse(path), "r");
  } catch {
    throw new PiHistoryError("missing");
  }
  try {
    const bytes = Buffer.alloc(64 * 1024);
    let size = 0,
      end = -1;
    while (size < bytes.length && end < 0) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      end = bytes.indexOf(10, size);
      size += read.bytesRead;
    }
    if (end < 0 || end >= size) throw new PiHistoryError("header");
    try {
      return Header.parse(JSON.parse(bytes.toString("utf8", 0, end)));
    } catch {
      throw new PiHistoryError("header");
    }
  } finally {
    await file.close();
  }
}
export async function checkedSessionReference(
  value: string,
): Promise<SessionReference & { cwd: string }> {
  const reference = decodeSessionReference(value),
    header = await readSessionHeader(reference.path);
  if (reference.id !== undefined && reference.id !== header.id)
    throw new PiHistoryError("identity");
  return { path: reference.path, id: header.id, cwd: header.cwd };
}
