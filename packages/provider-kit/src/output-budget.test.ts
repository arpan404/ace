import { expect, test } from "vitest";
import { outputGate, type DroppedOutputLine } from "./output-budget.ts";

test.each([
  {
    chunks: ["12345678", "9", "extra\n", "next\n"],
    output: "next\n",
    notices: [
      { bytes: 9, prefix: "12345678", phase: "start" },
      { bytes: 14, prefix: "12345678", phase: "end" },
    ],
  },
  {
    chunks: ["1234", "56789extra\nnext", "\n"],
    output: "next\n",
    notices: [{ bytes: 14, prefix: "12345678", phase: "complete" }],
  },
  {
    chunks: ["ok\n123456789", "extra\r", "\nnext\n"],
    output: "ok\n\nnext\n",
    notices: [
      { bytes: 9, prefix: "12345678", phase: "start" },
      { bytes: 14, prefix: "12345678", phase: "end" },
    ],
  },
])(
  "skipping an oversized line keeps the next line intact across chunks ($chunks)",
  async ({ chunks, output: expected, notices }) => {
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
    expect(Buffer.concat(output).toString()).toBe(expected);
    expect(failures).toEqual([]);
    expect(dropped).toEqual(notices);
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
  expect(dropped).toEqual([
    { bytes: 9, prefix: "12345678", phase: "start" },
    { bytes: 9, prefix: "12345678", phase: "end" },
  ]);
});

test("crossing the line budget reports lost state before a newline arrives", async () => {
  const notices: DroppedOutputLine[] = [];
  const gate = outputGate(
    8,
    () => true,
    (error) => {
      throw error;
    },
    (line) => notices.push(line),
  );
  gate.resume();
  const ended = new Promise<void>((resolve) => gate.on("end", resolve));
  gate.write(Buffer.from("123456789"));
  expect(notices).toEqual([{ bytes: 9, prefix: "12345678", phase: "start" }]);
  gate.end(Buffer.from("longer\n"));
  await ended;
  expect(notices.at(-1)).toEqual({ bytes: 15, prefix: "12345678", phase: "end" });
});
