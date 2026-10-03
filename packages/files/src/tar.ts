/** Fresh POSIX ustar/PAX writer. Extended records remove the 8 GiB and name limits. */
interface Member {
  name: string;
  size: number;
  mtime: number;
  directory: boolean;
}
function octal(block: Buffer, value: number, offset: number, width: number): void {
  block.write(
    Math.floor(value)
      .toString(8)
      .padStart(width - 1, "0") + "\0",
    offset,
    width,
    "ascii",
  );
}
function makeBlock(name: string, size: number, mtime: number, type: string): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write(name, 0, 100, "utf8");
  octal(bytes, type === "5" ? 0o755 : 0o644, 100, 8);
  octal(bytes, 0, 108, 8);
  octal(bytes, 0, 116, 8);
  octal(bytes, size, 124, 12);
  octal(bytes, Math.max(0, mtime), 136, 12);
  bytes.fill(32, 148, 156);
  bytes.write(type, 156, 1, "ascii");
  bytes.write("ustar\0", 257, "ascii");
  bytes.write("00", 263, "ascii");
  let checksum = 0;
  for (const byte of bytes) checksum += byte;
  bytes.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return bytes;
}
function record(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(body);
  let length = bytes + 1;
  for (;;) {
    const next = bytes + String(length).length;
    if (next === length) return `${length}${body}`;
    length = next;
  }
}
export function* tarHeaders(member: Member): Generator<Buffer> {
  const fields: string[] = [];
  const longName = Buffer.byteLength(member.name) > 100;
  const large = member.size >= 8 * 1024 ** 3;
  const mtime = Math.floor(member.mtime / 1000);
  if (longName) fields.push(record("path", member.name));
  if (large) fields.push(record("size", String(member.directory ? 0 : member.size)));
  if (mtime < 0 || mtime >= 8 * 1024 ** 3) fields.push(record("mtime", String(mtime)));
  if (fields.length) {
    const payload = Buffer.from(fields.join(""));
    yield makeBlock("PaxHeader", payload.length, 0, "x");
    yield payload;
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield makeBlock(
    longName ? "ace-entry" : member.name,
    member.directory || large ? 0 : member.size,
    mtime < 0 || mtime >= 8 * 1024 ** 3 ? 0 : mtime,
    member.directory ? "5" : "0",
  );
}
