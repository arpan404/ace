import { expect, it } from "vitest";
import { JsonElider } from "./elision.ts";

const limits = { holdBytes: 64, textBytes: 128 };
function elide(input: string, chunkBytes: number): string {
  const bytes = new TextEncoder().encode(input),
    out: Uint8Array[] = [];
  const elider = new JsonElider(limits, (chunk) => out.push(chunk.slice()));
  for (let at = 0; at < bytes.length; at += chunkBytes)
    elider.push(bytes.subarray(at, at + chunkBytes));
  elider.end();
  return Buffer.concat(out).toString("utf8");
}

it.each([1, 7, 64, 4096])(
  "heavy strings are elided and the rest survives intact across %i-byte chunks",
  (chunkBytes) => {
    const value = {
      small: 'a"quoted\\ value',
      image: `data:image/png;base64,${"QUJD".repeat(64)}`,
      data: "QUJD".repeat(64),
      text: `${"héllo wörld \\u00e9 \u{1F600} ".repeat(16)}`,
      nested: [{ keep: "x".repeat(40) }],
    };
    const parsed = JSON.parse(elide(JSON.stringify(value), chunkBytes));
    expect(parsed.small).toBe(value.small);
    expect(parsed.nested).toEqual(value.nested);
    expect(parsed.image).toBe(`[ace: ${value.image.length} bytes of data:image/png;base64 elided]`);
    expect(parsed.data).toBe(`[ace: ${value.data.length} bytes of base64 data elided]`);
    expect(
      value.text.startsWith(parsed.text.replace(/\[ace: \d+ more bytes truncated\]$/, "")),
    ).toBe(true);
    expect(parsed.text).toMatch(/\[ace: \d+ more bytes truncated\]$/);
  },
);

it("a line feed ends an unterminated string so the next SSE frame is read normally", () => {
  const output = elide(`data: {"a":"${"Q".repeat(200)}\n\ndata: {"b":"ok"}\n\n`, 5);
  expect(output.split("\n\n")[1]).toBe('data: {"b":"ok"}');
});
