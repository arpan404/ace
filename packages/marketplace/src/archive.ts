import { ContainedPath } from "@ace/protocol";

/*
 * An entry version's archive (ADR 0168 §2): its folder as a tar stream holding regular files and
 * folders only. Written here in one canonical form (sorted, mtime 0, owner 0, mode 644 or 755),
 * read here from any POSIX tar a publisher's own tool made, refusing links, devices, sparse files
 * and anything else that isn't a plain file. Pure: bytes in, bytes out.
 */

export interface ArchiveFile {
  path: string;
  executable: boolean;
  content: Uint8Array;
}

export interface ArchiveLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
  depth: number;
}

export class ArchiveError extends Error {
  override name = "ArchiveError";
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message);
    this.path = path;
  }
}

const block = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function normalise(input: string): string {
  const parsed = ContainedPath.safeParse(input);
  if (!parsed.success) throw new ArchiveError(`${input} isn't a path inside the folder`, input);
  return parsed.data.startsWith("./") ? parsed.data.slice(2) : parsed.data;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  return decoder.decode(bytes.subarray(offset, end));
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  const text = readString(bytes, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]{1,12}$/.test(text)) throw new ArchiveError("The archive has a damaged header");
  return Number.parseInt(text, 8);
}

function checksumOf(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < block; index++)
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  return sum;
}

/** `path` and `size` from a pax extended header; other keys (times, xattrs) are ignored. */
function readPax(content: Uint8Array): { path?: string; size?: number } {
  const text = decoder.decode(content);
  const result: { path?: string; size?: number } = {};
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    const length = Number(text.slice(at, space));
    if (space < 0 || !Number.isInteger(length) || length <= 0)
      throw new ArchiveError("The archive has a damaged extended header");
    const record = text.slice(space + 1, at + length - 1);
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") result.path = value;
    if (key === "size") result.size = Number(value);
    at += length;
  }
  return result;
}

/** Every regular file in `archive`, in path order. Throws `ArchiveError` on anything else. */
export function readArchive(archive: Uint8Array, limits: ArchiveLimits): ArchiveFile[] {
  const files = new Map<string, ArchiveFile>();
  const folders = new Set<string>();
  let total = 0;
  let offset = 0;
  let pax: { path?: string; size?: number } = {};
  while (offset + block <= archive.byteLength) {
    const header = archive.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) break;
    if (readOctal(header, 148, 8) !== checksumOf(header))
      throw new ArchiveError("The archive has a damaged header");
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const name = pax.path ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const size = pax.size ?? readOctal(header, 124, 12);
    const mode = readOctal(header, 100, 8);
    offset += block;
    const start = offset;
    offset += Math.ceil(size / block) * block;
    if (offset > archive.byteLength) throw new ArchiveError("The archive ends early");
    const content = archive.subarray(start, start + size);
    if (type === "x") {
      if (size > 64 * 1024) throw new ArchiveError("The archive has an oversized extended header");
      pax = readPax(content);
      continue;
    }
    pax = {};
    if (type === "g") continue;
    const trimmed = name.replace(/\/+$/, "");
    if (type === "5") {
      if (trimmed === "" || trimmed === ".") continue;
      folders.add(normalise(trimmed));
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7")
      throw new ArchiveError(
        `${name} is ${type === "1" || type === "2" ? "a link" : "not a regular file"}; an entry holds only its own files`,
        name,
      );
    const path = normalise(trimmed);
    if (path.split("/").length > limits.depth)
      throw new ArchiveError(`${path} is nested too deep`, path);
    if (files.has(path)) throw new ArchiveError(`${path} appears twice`, path);
    if (files.size >= limits.files)
      throw new ArchiveError(`an entry of this type holds at most ${limits.files} files`);
    if (size > limits.fileBytes)
      throw new ArchiveError(`${path} is ${size} bytes; the limit is ${limits.fileBytes}`, path);
    total += size;
    if (total > limits.totalBytes)
      throw new ArchiveError(`the files come to over ${limits.totalBytes} bytes, the limit`);
    files.set(path, { path, executable: (mode & 0o111) !== 0, content: content.slice() });
  }
  for (const path of files.keys())
    if (folders.has(path)) throw new ArchiveError(`${path} is both a file and a folder`, path);
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      if (files.has(parts.slice(0, depth).join("/")))
        throw new ArchiveError(`${path} is inside a file`, path);
  }
  return [...files.values()].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new ArchiveError(`${value} is too long for a tar field`);
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  writeString(header, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function headerFor(name: string, size: number, mode: number, type: string): Uint8Array {
  const header = new Uint8Array(block);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header[156] = type.charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 148, 8, checksumOf(header).toString(8).padStart(6, "0") + "\0 ");
  return header;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.byteLength / block) * block);
  out.set(bytes);
  return out;
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = encoder.encode(body).byteLength;
  // The length counts its own digits.
  let length = bodyBytes + 1;
  while (length !== bodyBytes + String(length).length) length = bodyBytes + String(length).length;
  return `${length}${body}`;
}

/** The canonical archive of `files`: the same files always make the same bytes. */
export function writeArchive(files: readonly ArchiveFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const path = normalise(file.path);
    if (encoder.encode(path).byteLength > 100) {
      const record = encoder.encode(paxRecord("path", path));
      parts.push(headerFor("././@PaxHeader", record.byteLength, 0o644, "x"), padded(record));
    }
    // A long path lives in its pax record; the header's own name is only a placeholder.
    const short = encoder.encode(path).byteLength > 100 ? "ace-long-path" : path;
    parts.push(
      headerFor(short, file.content.byteLength, file.executable ? 0o755 : 0o644, "0"),
      padded(file.content),
    );
  }
  parts.push(new Uint8Array(block * 2));
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
