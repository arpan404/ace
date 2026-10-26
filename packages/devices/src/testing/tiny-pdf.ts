import { deflateSync } from "node:zlib";

/**
 * A one-page PDF of `width` × `height` whose page draws `content` (PDF drawing operators),
 * compressed as Apple's are. `graphics` names ExtGState entries the drawing can select with
 * `gs`. For tests: a stand-in for the device art Xcode ships, never a copy of it.
 */
export function tinyPdf(
  width: number,
  height: number,
  content: string,
  graphics: Record<string, string> = {},
): Uint8Array {
  const stream = deflateSync(Buffer.from(content, "latin1"));
  const states = Object.entries(graphics)
    .map(([name, dict]) => `/${name} << ${dict} >>`)
    .join(" ");
  const parts = [
    "%PDF-1.3\n",
    `3 0 obj\n<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`,
  ];
  const tail = [
    "\nendstream\nendobj\n",
    `1 0 obj\n<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 3 0 R >>\nendobj\n`,
    `4 0 obj\n<< /ExtGState << ${states} >> >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /MediaBox [0 0 ${width} ${height}] /Count 1 /Kids [ 1 0 R ] >>\nendobj\n`,
    "trailer\n<< /Root 5 0 R >>\n%%EOF\n",
  ];
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(parts.join(""), "latin1"),
      stream,
      Buffer.from(tail.join(""), "latin1"),
    ]),
  );
}
