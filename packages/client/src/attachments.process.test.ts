import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { codexCapabilities } from "@ace/adapter-codex";
import { AdapterRegistry } from "@ace/daemon";
import { ContentPart } from "@ace/protocol";
import type { Fact } from "@ace/core";
import { setup, ready } from "./test-support.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test("draft upload becomes a path-free user item and this daemon connection resolves exact bytes and a bounded preview", async () => {
  const capabilities = codexCapabilities({
    installed: true,
    version: "0.159.1",
    auth: "logged_in",
    loginHint: "",
  });
  const scripted = createScriptedAdapter({
    provider: "codex",
    capabilities,
    steps: [],
    createTranslator: () => ({
      translate(frame): Fact[] {
        const parts = ContentPart.array().parse(frame.data);
        return [
          { type: "turn.started", agent: "root", trigger: "user" },
          {
            type: "item.upsert",
            agent: "root",
            item: "user",
            draft: {
              type: "message",
              role: "user",
              complete: true,
              parts,
              raw: [{ type: "echo", data: frame.data }],
            },
          },
          { type: "turn.ended", agent: "root", outcome: "completed" },
        ];
      },
      tick: () => [],
    }),
  });
  const registry = new AdapterRegistry();
  let sequence = 0;
  registry.register(
    {
      ...scripted,
      async openSession(ctx) {
        const session = await scripted.openSession(ctx);
        return {
          ...session,
          async send(input, delivery, id) {
            await session.send(input, delivery, id);
            await ctx.onFrame({
              seq: ++sequence,
              t: sequence,
              dir: "recv",
              channel: "testkit",
              data: input,
            });
          },
        };
      },
    },
    { installed: true, version: "0.159.1", auth: "logged_in", loginHint: "" },
  );
  const f = await setup(undefined, undefined, { registry });
  try {
    await promisify(execFile)("git", ["init", "-q", f.directory]);
    const { client } = f.make();
    await ready(client);
    const bytes = await readFile(new URL("../../context/fixtures/colours.png", import.meta.url)),
      sha256 = hash(bytes);
    const draft = await client.request({
      type: "context.request",
      operation: { op: "draft.create", workspaceId: f.workspaceId },
    });
    if (draft.result.kind !== "draft") throw new Error("Expected draft");
    const begin = await client.request({
      type: "context.request",
      operation: {
        op: "draft.upload.begin",
        draftId: draft.result.draftId,
        bytes: bytes.length,
        sha256,
        name: "screen.png",
      },
    });
    if (begin.result.kind !== "upload") throw new Error("Expected upload");
    for (let offset = 0; offset < bytes.length; offset += 65531)
      await client.request({
        type: "context.request",
        operation: {
          op: "upload.chunk",
          uploadId: begin.result.uploadId,
          offset,
          data: bytes.subarray(offset, offset + 65531).toString("base64"),
        },
      });
    const committed = await client.request({
      type: "context.request",
      operation: { op: "upload.commit", uploadId: begin.result.uploadId },
    });
    expect(committed.result).toMatchObject({
      kind: "attachment",
      attachment: { sha256, mimeType: "image/png", width: 320, height: 240 },
    });
    const created = await client.command({
      type: "thread.create",
      workspaceId: f.workspaceId,
      provider: "codex",
      mode: "local",
      input: [{ type: "text", text: "what do you see?" }],
      context: { draftId: draft.result.draftId, mentions: [], attachments: [{ sha256 }] },
    });
    if (!created.threadId) throw new Error(`Thread creation failed: ${JSON.stringify(created)}`);
    await f.daemon.engine?.flush();
    const page = await client.itemsPage({ threadId: created.threadId, limit: 20 });
    const message = page.items.find((item) => item.type === "message" && item.role === "user");
    expect(message).toMatchObject({
      parts: [{ type: "text", text: "what do you see?" }],
      attachments: [
        {
          sha256,
          name: "screen.png",
          bytes: bytes.length,
          mimeType: "image/png",
          width: 320,
          height: 240,
          thumbnailAvailable: true,
        },
      ],
      raw: [],
    });
    expect(JSON.stringify(message)).not.toContain(f.directory);
    const original = await client.attachmentBytes({
      threadId: created.threadId,
      sha256,
      variant: "original",
      maxBytes: bytes.length,
    });
    expect(hash(original.bytes)).toBe(sha256);
    const thumbnail = await client.attachmentBytes({ threadId: created.threadId, sha256 });
    expect(thumbnail.mimeType).toBe("image/png");
    expect(thumbnail.bytes.length).toBeLessThan(256 * 1024);
    await expect(client.attachmentBytes({ threadId: f.thread.id, sha256 })).rejects.toThrow();
    const sent = scripted.commands.find((command) => command.type === "send");
    if (sent?.type !== "send") throw new Error("Expected provider input");
    const image = sent.input.find((part) => part.type === "file");
    if (image?.type !== "file") throw new Error("Expected native image filename");
    expect(image.mimeType).toBe("image/png");
    expect(image.path.endsWith(".png")).toBe(true);
    expect(hash(await readFile(image.path))).toBe(sha256);
  } finally {
    await f.cleanup();
  }
});
