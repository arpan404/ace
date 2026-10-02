import { expect, it } from "vitest";
import { harness } from "./test-helper.ts";

it("emits bounded item states after ten MiB of ASCII output and preserves the stream through completion", () => {
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

it("splits output at whole UTF-8 characters without dropping or duplicating bytes", () => {
  const h = harness();
  h.see();
  h.start();
  h.shell();
  const text = "x".repeat(4094) + "😀é" + "y".repeat(4095);
  const deltas = h
    .send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: text })
    .filter((event) => event.type === "item.delta");
  expect(deltas.map((event) => event.append).join("")).toBe(text);
  for (const event of deltas) {
    expect(Buffer.byteLength(event.append)).toBeLessThanOrEqual(4096);
    expect(event.append).not.toContain("�");
  }
  expect(h.item("shell")).toMatchObject({
    call: { detail: { output: { bytes: 8195, tail: "y".repeat(4095), truncated: true } } },
  });
});

it.each([true, false])(
  "rejects adapter output summaries (kind supplied: %s) while preserving the core stream",
  (includeKind) => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: "thirteenbytes",
    });
    const before = structuredClone(h.item("shell"));
    const rejected = h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: {
        type: "tool_call",
        call: {
          detail: {
            ...(includeKind ? { kind: "shell" } : {}),
            output: { streamId: "other", bytes: 0, tail: "", truncated: false },
          },
        },
      },
    });
    expect(h.item("shell")).toEqual(before);
    expect(rejected).toContainEqual(
      expect.objectContaining({
        type: "item.created",
        item: expect.objectContaining({ type: "notice" }),
      }),
    );
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", call: { detail: { kind: "shell", exitCode: 0 } } },
    });
    h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "!" });
    expect(h.item("shell")).toMatchObject({
      call: {
        detail: { output: { streamId: `output:${before?.id}`, bytes: 14, tail: "thirteenbytes!" } },
      },
    });
  },
);
it.each(["\0", '"', "\\", "\n"])(
  "bounds serialized output events even when JSON escapes %j",
  (character) => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    // Size/escaping boundaries need multiple chunks; the separate ASCII case covers ten MiB.
    const bytes = 64 * 1024;
    const text = character.repeat(bytes);
    const deltas = h.send({
      type: "item.delta",
      agent: "root",
      item: "shell",
      field: "output",
      append: text,
    });
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", complete: true },
    });
    expect(
      deltas
        .filter((e) => e.type === "item.delta")
        .map((e) => e.append)
        .join(""),
    ).toBe(text);
    for (const event of h.history)
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(8192);
    expect(h.item("shell")).toMatchObject({
      call: { detail: { output: { bytes, truncated: true } } },
    });
  },
);
