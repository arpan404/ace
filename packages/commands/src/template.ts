/** A single pass; substitutions are literal. Stop before constructing an oversized result. */
export function expandTemplate(
  template: string,
  pattern: RegExp,
  substitute: (match: RegExpExecArray) => string,
): string | undefined {
  const chunks: string[] = [];
  let offset = 0,
    bytes = 0;
  for (const match of template.matchAll(pattern)) {
    const literal = template.slice(offset, match.index);
    const value = substitute(match);
    bytes += Buffer.byteLength(literal) + Buffer.byteLength(value);
    if (bytes > 65536) return undefined;
    chunks.push(literal, value);
    offset = match.index + match[0].length;
  }
  const tail = template.slice(offset);
  if (bytes + Buffer.byteLength(tail) > 65536) return undefined;
  chunks.push(tail);
  return chunks.join("");
}
