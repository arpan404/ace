import { z } from "zod";
import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { ToolRegistry, agentControlToolkit } from "@ace/mcp-server";
import { createAgentControlPort } from "@ace/daemon";
import { setup } from "./test-support.ts";

const Page = z.object({
  ok: z.literal(true),
  data: z.object({ text: z.string(), nextOffset: z.number(), eof: z.boolean() }),
});

async function reader() {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "writer");
  await h.engine.flush();
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  agentControlToolkit(createAgentControlPort(h.store, h.service)).register(registry);
  /** Every page of a stream, read the way an agent does: nextOffset passed back unchanged. */
  async function pages(threadId: ThreadId, streamId: string, maxBytes: number) {
    const read: string[] = [];
    let offset = 0;
    for (let turn = 0; turn < 10_000; turn++) {
      const result = await registry.call(
        "thread_read",
        { threadId, streamId, offset, maxBytes },
        { scope: { ...parent, capabilities: [] }, signal: new AbortController().signal },
        new AbortController().signal,
      );
      const page = Page.parse(result.structuredContent).data;
      read.push(page.text);
      if (page.eof) return read;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    throw new Error("Stream never ended");
  }
  return { h, child: child.childId, pages };
}

// Each character here is 1 or 2 UTF-16 units and 1 to 4 UTF-8 bytes, so fixed-size pages
// land inside characters unless reads snap to whole ones.
const mixed = "a😀中é🇳🇵".repeat(1200);

test("a long message with emoji and CJK reads back exactly as text across pages", async () => {
  const { h, child, pages } = await reader();
  await h.complete(child, mixed);
  const item = h.store
    .readItemPage(child, h.store.headSeq() + 1, 20)
    .items.find((entry) => entry.type === "message" && entry.role === "assistant");
  const part = item?.type === "message" ? item.parts.find((p) => p.type === "text") : undefined;
  if (part?.type !== "text" || !part.source) throw new Error("Large message has no source stream");

  // 1023 bytes is odd, so a byte cut would split UTF-16 units as well as surrogate pairs.
  const read = await pages(child, part.source.streamId, 1023);
  expect(read.length).toBeGreaterThan(5);
  for (const text of read) expect(text.isWellFormed()).toBe(true);
  expect(read.join("")).toBe(mixed);
});

test("shell output stored as UTF-8 reads back as text without splitting a character", async () => {
  const { h, child, pages } = await reader();
  await h.emit(child, {
    type: "item.upsert",
    agent: "root",
    item: "build",
    draft: {
      type: "tool_call",
      complete: false,
      call: {
        kind: "shell",
        title: "Build",
        status: "running",
        detail: { kind: "shell", command: "build" },
      },
    },
  });
  const halves = [mixed.slice(0, 3001), mixed.slice(3001)];
  for (const append of halves)
    await h.emit(child, {
      type: "item.delta",
      agent: "root",
      item: "build",
      field: "output",
      append,
    });
  const shell = Object.values(h.store.snapshotThread(child).items).find(
    (item) => item.type === "tool_call",
  );
  const streamId =
    shell?.type === "tool_call" && shell.call.detail.kind === "shell"
      ? shell.call.detail.output?.streamId
      : undefined;
  if (!streamId) throw new Error("Shell output has no stream");

  const read = await pages(child, streamId, 1001);
  expect(read.length).toBeGreaterThan(5);
  for (const text of read) expect(text).not.toContain("�");
  expect(read.join("")).toBe(mixed);
});

test("a page smaller than one character still returns that whole character and moves on", async () => {
  const { h, child, pages } = await reader();
  const text = "😀".repeat(3000);
  await h.complete(child, text);
  const item = h.store
    .readItemPage(child, h.store.headSeq() + 1, 20)
    .items.find((entry) => entry.type === "message" && entry.role === "assistant");
  const part = item?.type === "message" ? item.parts.find((p) => p.type === "text") : undefined;
  if (part?.type !== "text" || !part.source) throw new Error("Large message has no source stream");

  const read = await pages(child, part.source.streamId, 1);
  expect(read.slice(0, 3)).toEqual(["😀", "😀", "😀"]);
  expect(read.join("")).toBe(text);
});
