import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";

it("emits bounded item states after ten MiB of output and preserves the stream through completion", () => {
  const h = harness();
  h.see();
  h.start();
  h.shell();
  h.send({
    type: "item.delta",
    agent: "root",
    item: "shell",
    field: "output",
    append: "x".repeat(10 * 1024 * 1024),
  });
  h.send({
    type: "item.upsert",
    agent: "root",
    item: "shell",
    draft: {
      type: "tool_call",
      complete: true,
      call: { status: "succeeded", detail: { kind: "shell", exitCode: 0 } },
    },
  });
  h.end();
  const summary = h.item("shell");
  expect(summary).toMatchObject({
    call: {
      detail: {
        output: {
          streamId: `output:${summary?.id}`,
          bytes: 10 * 1024 * 1024,
          tail: "x".repeat(4096),
          truncated: true,
        },
      },
    },
  });
  for (const event of h.history)
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(8192);
  expect(Buffer.byteLength(JSON.stringify(h.state))).toBeLessThan(16 * 1024);
});
