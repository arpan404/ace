import { expect, test } from "vitest";
import { createAcpTranslator, createTranslatorIdentity } from "@ace/adapter-acp";
import { createPiTranslator } from "@ace/adapter-pi";
import type { Frame } from "@ace/engine-api";
import { harness, scriptFrames } from "./test-support.ts";
const frame = (seq: number, dir: Frame["dir"], data: unknown): Frame => ({
  seq,
  t: seq,
  dir,
  channel: "stdio",
  data,
});

test("Pi file echoes update the original admitted message", async () => {
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frame(1, "recv", { type: "message_start", message: { role: "user" } }),
          frame(2, "recv", {
            type: "message_end",
            message: { role: "user", content: "Read this\nFile: /tmp/file.md" },
          }),
        ],
      },
    ],
    scriptFrames(),
    { provider: "pi", createTranslator: createPiTranslator },
  );
  try {
    const receipt = h.command(
      {
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "pi",
        input: [
          { type: "text", text: "Read this" },
          { type: "file", path: "/tmp/file.md" },
        ],
      },
      "device",
      "pi-file",
    );
    if (!receipt.threadId) throw new Error("No thread");
    await h.engine.flush();
    const items = Object.values(h.store.snapshotThread(receipt.threadId).items).filter(
      (item) => item.type === "message" && item.role === "user",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "input:pi-file",
      parts: [
        { type: "text", text: "Read this" },
        { type: "file", path: "/tmp/file.md" },
      ],
    });
  } finally {
    await h.close();
  }
});

test("ACP outgoing prompt and streamed user chunks reconcile to one admitted item", async () => {
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frame(0, "send", { id: 0, method: "session/new", params: { cwd: "/repo" } }),
          frame(1, "recv", { id: 0, result: { sessionId: "native-1" } }),
          frame(2, "send", {
            id: 1,
            method: "session/prompt",
            params: { sessionId: "native-1", prompt: [{ type: "text", text: "Read this" }] },
          }),
          frame(3, "recv", {
            method: "session/update",
            params: {
              sessionId: "native-1",
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "Read " },
              },
            },
          }),
          frame(4, "recv", {
            method: "session/update",
            params: {
              sessionId: "native-1",
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "this" },
              },
            },
          }),
          frame(5, "recv", { id: 1, result: { stopReason: "end_turn" } }),
        ],
      },
    ],
    scriptFrames(),
    {
      provider: "acp",
      createTranslator: (init) =>
        createAcpTranslator({ ...init, identity: createTranslatorIdentity("echo-generation") }),
    },
  );
  try {
    const receipt = h.command(
      {
        type: "thread.create",
        workspaceId: h.workspace,
        provider: "acp",
        acpAgentId: "test-agent",
        installationId: "test-install",
        instanceId: "test-instance",
        input: [{ type: "text", text: "Read this" }],
      },
      "device",
      "acp-stream",
    );
    if (!receipt.threadId) throw new Error("No thread");
    await h.engine.flush();
    const items = Object.values(h.store.snapshotThread(receipt.threadId).items).filter(
      (item) => item.type === "message" && item.role === "user",
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "input:acp-stream",
      complete: true,
      parts: [{ type: "text", text: "Read this" }],
    });
  } finally {
    await h.close();
  }
});
