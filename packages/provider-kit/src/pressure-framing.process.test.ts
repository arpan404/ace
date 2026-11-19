import { PassThrough } from "node:stream";
import { once } from "node:events";
import { expect, test } from "vitest";
import { lineReader } from "./line-reader.ts";

// Mutation cases: LF-only framing; CR-only unbounded retention. Not executed (tests run at merge).
test.each(["\n", "\r", "\r\n"])(
  "a 64 KiB %j burst pauses between complete lines",
  async (ending) => {
    const input = new PassThrough();
    const blocked = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let paused = false;
    const failures: Error[] = [];
    const lines = lineReader(input, 65536, (error) => failures.push(error), {
      paused: () => paused,
      wait: () => {
        blocked.resolve();
        return resume.promise;
      },
    });
    const received: string[] = [];
    lines.on("line", (line) => {
      received.push(line);
      paused = received.length === 1;
    });
    const closed = once(lines, "close");
    const records = Array.from({ length: 1024 }, (_, i) =>
      String(i).padEnd(64 - ending.length, "x"),
    );
    const burst = records.join(ending) + ending;
    expect(Buffer.byteLength(burst)).toBe(65536);
    input.end(burst);
    await blocked.promise;
    expect(received).toEqual([records[0]]);
    paused = false;
    resume.resolve();
    await closed;
    expect(received).toEqual(records);
    expect(failures).toEqual([]);
  },
);

test("JSON lines carrying U+2028, U+2029 and U+FDD0 inside strings arrive whole and unchanged", async () => {
  const input = new PassThrough();
  const lines = lineReader(input, 1024, (error) => {
    throw error;
  });
  const received: string[] = [];
  lines.on("line", (line) => received.push(line));
  const closed = once(lines, "close");
  const records = [
    JSON.stringify({ value: "7×6=42\u20297×6=42" }),
    JSON.stringify({ text: "a\u2028b", kept: "\uFDD01" }),
  ];
  input.end(records.join("\n") + "\n");
  await closed;
  expect(received).toEqual(records);
  expect(received.map((line) => JSON.parse(line) as unknown)).toEqual([
    { value: "7×6=42\u20297×6=42" },
    { text: "a\u2028b", kept: "\uFDD01" },
  ]);
});

test("async iteration gets the same whole lines", async () => {
  const input = new PassThrough();
  const lines = lineReader(input, 1024, (error) => {
    throw error;
  });
  const iterator = lines[Symbol.asyncIterator]();
  input.end('{"a":"x\u2029y"}\n');
  const received: string[] = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next())
    received.push(String(next.value));
  expect(received).toEqual(['{"a":"x\u2029y"}']);
});

test("a CRLF split across reads terminates one line and preserves the next record", async () => {
  const input = new PassThrough();
  const lines = lineReader(input, 64, (error) => {
    throw error;
  });
  const first = Promise.withResolvers<void>();
  const received: string[] = [];
  lines.on("line", (line) => {
    received.push(line);
    first.resolve();
  });
  const closed = once(lines, "close");
  input.write("first\r");
  await first.promise;
  input.end("\nsecond\r\nthird\n");
  await closed;
  expect(received).toEqual(["first", "second", "third"]);
});
