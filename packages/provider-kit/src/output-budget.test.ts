import { expect, test } from "vitest";
import { outputGate, type DroppedOutputLine } from "./output-budget.ts";

test.each([
  ["12345678", "9", "extra\n", "next\n"],
  ["1234", "56789extra\nnext", "\n"],
  ["ok\n123456789", "extra\r", "\nnext\n"],
])(
  "skipping an oversized line keeps the next line intact across chunks (%j)",
  async (...chunks) => {
    const dropped: DroppedOutputLine[] = [];
    const failures: Error[] = [];
    const gate = outputGate(
      8,
      () => true,
      (error) => failures.push(error),
      (line) => dropped.push(line),
    );
    const output: Buffer[] = [];
    gate.on("data", (chunk: Buffer) => output.push(chunk));
    const ended = new Promise<void>((resolve) => gate.on("end", resolve));
    for (const chunk of chunks) gate.write(Buffer.from(chunk));
    gate.end();
    await ended;
    expect(Buffer.concat(output).toString()).toBe(
      chunks[0]?.startsWith("ok") ? "ok\n\nnext\n" : "next\n",
    );
    expect(failures).toEqual([]);
    expect(dropped).toEqual([{ bytes: 14, prefix: "12345678" }]);
  },
);

test("a line ending exactly at the limit is retained and a dropped final line is reported at EOF", async () => {
  const dropped: DroppedOutputLine[] = [];
  const gate = outputGate(
    8,
    () => true,
    (error) => {
      throw error;
    },
    (line) => dropped.push(line),
  );
  const output: Buffer[] = [];
  gate.on("data", (chunk: Buffer) => output.push(chunk));
  const ended = new Promise<void>((resolve) => gate.on("end", resolve));
  gate.write(Buffer.from("12345678"));
  gate.write(Buffer.from("\n12345678"));
  gate.end(Buffer.from("9"));
  await ended;
  expect(Buffer.concat(output).toString()).toBe("12345678\n");
  expect(dropped).toEqual([{ bytes: 9, prefix: "12345678" }]);
});
