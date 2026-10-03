import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { readJsonLines } from "@ace/provider-kit/jsonl";
test("LF framing preserves Unicode separators and split UTF-8 characters", () => {
  const input = new PassThrough(),
    lines: string[] = [],
    errors: Error[] = [];
  const detach = readJsonLines(
    input,
    128,
    (line) => lines.push(line),
    (error) => errors.push(error),
  );
  const bytes = Buffer.from('{"text":"é\u2028a\u2029b"}\r\n');
  for (const byte of bytes) input.write(Buffer.from([byte]));
  expect(lines).toEqual(['{"text":"é\u2028a\u2029b"}']);
  expect(errors).toEqual([]);
  detach();
  input.destroy();
});
test("an unterminated oversized JSONL record fails before another record can be delivered", () => {
  const input = new PassThrough(),
    lines: string[] = [],
    errors: Error[] = [];
  const detach = readJsonLines(
    input,
    3,
    (line) => lines.push(line),
    (error) => errors.push(error),
  );
  input.write("ab");
  input.write("cd\nx\n");
  expect(errors.map((error) => error.message)).toEqual(["JSONL line exceeded limit"]);
  expect(lines).toEqual([]);
  detach();
  input.destroy();
});
