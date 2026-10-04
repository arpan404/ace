import { PassThrough } from "node:stream";
import { once } from "node:events";
import { expect, it } from "vitest";
import { lineReader } from "./line-reader.ts";

it("pausing on one line stops the remainder of a 64 KiB burst until resume", async () => {
  const input = new PassThrough();
  const failures: Error[] = [];
  const lines = lineReader(input, 65536, (error) => failures.push(error));
  const received: string[] = [];
  lines.on("line", (line) => {
    received.push(line);
    if (received.length === 1) lines.pause();
  });
  const records = Array.from({ length: 1024 }, (_, i) => String(i).padEnd(63, "x"));
  const burst = records.join("\n") + "\n";
  expect(Buffer.byteLength(burst)).toBe(65536);
  const paused = once(lines, "pause");
  input.end(burst);
  await paused;
  expect(received).toEqual([records[0]]);
  const closed = new Promise<void>((resolve) => lines.once("close", resolve));
  lines.resume();
  await closed;
  expect(received).toEqual(records);
  expect(failures).toEqual([]);
});

it("JSON-RPC intake pauses inside a chunk and resumes its buffered suffix exactly once", async () => {
  const { readJsonLines } = await import("./jsonl.ts");
  const input = new PassThrough();
  const failures: Error[] = [];
  const received: string[] = [];
  let paused = false;
  const gate = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  const detach = readJsonLines(
    input,
    65536,
    (line) => {
      received.push(line);
      if (received.length === 8) paused = true;
    },
    (error) => failures.push(error),
    {
      paused: () => paused,
      wait: () => {
        blocked.resolve();
        return gate.promise;
      },
    },
  );
  const closed = new Promise<void>((resolve) => input.once("end", resolve));
  input.end(Array.from({ length: 1000 }, (_, i) => String(i)).join("\n") + "\n");
  await blocked.promise;
  expect(received).toEqual(Array.from({ length: 8 }, (_, i) => String(i)));
  paused = false;
  gate.resolve();
  await closed;
  detach();
  expect(received).toEqual(Array.from({ length: 1000 }, (_, i) => String(i)));
  expect(failures).toEqual([]);
});
