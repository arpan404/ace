/** Legacy offsets count UTF-16 units; limits count UTF-8 bytes. No full output copy. */
export function outputSlice(output: string, offset: number, limit: number): string {
  if (
    offset > 0 &&
    output.charCodeAt(offset) >= 0xdc00 &&
    output.charCodeAt(offset) <= 0xdfff &&
    output.charCodeAt(offset - 1) >= 0xd800 &&
    output.charCodeAt(offset - 1) <= 0xdbff
  )
    throw new Error("invalid_offset");
  let end = offset;
  let bytes = 0;
  while (end < output.length) {
    const code = output.charCodeAt(end);
    let width = 1;
    let size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      output.charCodeAt(end + 1) >= 0xdc00 &&
      output.charCodeAt(end + 1) <= 0xdfff
    ) {
      width = 2;
      size = 4;
    }
    if (bytes + size > limit) break;
    bytes += size;
    end += width;
  }
  if (end === offset && offset < output.length) throw new Error("limit_too_small");
  return output.slice(offset, end);
}
