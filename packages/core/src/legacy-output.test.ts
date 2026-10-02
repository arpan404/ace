import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";

it("accepts legacy draft output strings as append-only deltas without resending existing bytes", () => {
  const h = harness();
  h.see();
  h.start();
  h.shell();
  const upsert = (output: string) =>
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        call: { detail: { kind: "shell", output, outputTruncated: false } },
      },
    });
  const first = upsert("😀 first");
  const second = upsert("😀 first next");
  expect(first.filter((event) => event.type === "item.delta").map((event) => event.append)).toEqual(
    ["😀 first"],
  );
  expect(
    second.filter((event) => event.type === "item.delta").map((event) => event.append),
  ).toEqual([" next"]);
  expect(h.item("shell")).toMatchObject({
    call: { detail: { output: { bytes: 15, tail: "😀 first next", truncated: false } } },
  });
  expect(
    upsert("😀 first next")
      .filter((event) => event.type === "item.delta")
      .map((event) => event.append)
      .join(""),
  ).toBe("");
  const rejected = upsert("replacement");
  expect(rejected).toContainEqual(
    expect.objectContaining({
      type: "item.created",
      item: expect.objectContaining({ type: "notice", level: "warning" }),
    }),
  );
  expect(h.item("shell")).toMatchObject({
    call: { detail: { output: { bytes: 15, tail: "😀 first next" } } },
  });
});
it("streams a legacy first draft's large output while keeping every event bounded", () => {
  const h = harness();
  h.see();
  h.start();
  const events = h.send({
    type: "item.upsert",
    agent: "root",
    item: "shell",
    draft: {
      type: "tool_call",
      call: {
        kind: "shell",
        detail: { kind: "shell", command: "echo", output: "x".repeat(10 * 1024 * 1024) },
      },
    },
  });
  expect(
    events
      .filter((event) => event.type === "item.delta")
      .reduce((size, event) => size + Buffer.byteLength(event.append), 0),
  ).toBe(10 * 1024 * 1024);
  for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(8192);
  expect(h.item("shell")).toMatchObject({
    call: {
      detail: { output: { bytes: 10 * 1024 * 1024, tail: "x".repeat(4096), truncated: true } },
    },
  });
});
