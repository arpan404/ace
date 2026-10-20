import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("only streamed text keeps engine metadata; a tool call is stored once and still streams", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "item.delta",
            agent: "root",
            item: "shell",
            field: "output",
            append: "first",
          }),
        ],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const provider = h.contexts[0];
  if (!provider) throw new Error("Missing provider");
  const facts: Fact[] = [
    { type: "item.delta", agent: "root", item: "shell", field: "output", append: " second" },
    {
      type: "item.upsert",
      agent: "root",
      item: "shell",
      draft: { type: "tool_call", call: { status: "succeeded" } },
    },
    {
      type: "item.upsert",
      agent: "root",
      item: "answer",
      draft: { type: "message", role: "assistant", parts: [{ type: "text", text: "" }] },
    },
    { type: "item.delta", agent: "root", item: "answer", field: "text", append: "done" },
  ];
  for (const fact of facts) provider.onFrame(frames.frame(fact));
  await h.engine.flush();
  h.store.flushLiveWrites();

  const reader = new DatabaseSync(h.path, { readOnly: true });
  try {
    const metadata = reader
      .prepare(
        "SELECT json_extract(value,'$.type') AS type FROM engine_state_records WHERE thread_id=? AND section='itemMetadata'",
      )
      .all(id)
      .map((row) => row.type);
    // The person's prompt and the answer keep text-free metadata; the tool call has none.
    expect(metadata).not.toContain("tool_call");
    expect(metadata).toContain("message");
  } finally {
    reader.close();
  }
  const items = Object.values(h.store.snapshotThread(id).items);
  const shell = items.find((item) => item.type === "tool_call");
  if (shell?.type !== "tool_call" || shell.call.detail.kind !== "shell")
    throw new Error("Missing shell");
  expect(shell.call.status).toBe("succeeded");
  const stream = shell.call.detail.output?.streamId;
  if (!stream) throw new Error("Missing stream");
  expect(Buffer.from(h.store.readOutput(stream, 0, 1024).bytes, "base64").toString()).toBe(
    "first second",
  );
  expect(items.find((item) => item.type === "message" && item.role === "assistant")).toMatchObject({
    parts: [{ type: "text", text: "done" }],
  });
  expect(h.errors).toEqual([]);
});
