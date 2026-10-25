import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ProjectStorage } from "../project-storage.ts";
import { harness, scriptFrames } from "./test-support.ts";

test("a thread started in a chat's hidden project runs in the chat's folder and says it is a chat", async () => {
  const h = await harness([{ on: "send", frames: [] }], scriptFrames());
  try {
    const folder = join(h.store.getWorkspacePath(h.workspace) ?? "", "chats", "chat-1");
    mkdirSync(folder, { recursive: true });
    const chat = new ProjectStorage(h.store, () => 1).registerChat(folder, "Chat");
    const receipt = h.command(
      {
        type: "thread.create",
        workspaceId: chat.id,
        provider: "codex",
        input: [{ type: "text", text: "Hi" }],
      },
      "device",
      "chat-create",
    );
    if (!receipt.threadId) throw new Error(`No thread: ${receipt.error}`);
    expect(h.store.getThread(receipt.threadId)?.details).toMatchObject({
      workspace: { id: chat.id, kind: "chat", path: folder },
      mode: "local",
      worktree: folder,
    });
  } finally {
    await h.close();
  }
});
