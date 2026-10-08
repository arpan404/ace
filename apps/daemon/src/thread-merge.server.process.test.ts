import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitService } from "@ace/git";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { transitionHarness } from "./engine/transition-test-support.ts";
import { startServer } from "./server.ts";
import { token } from "./socket-test-support.ts";
import { command, connect, repository } from "./thread-creation-test-support.ts";
import { until } from "./projects-test-support.ts";

test("a merge through the real server applies the patch once and publishes a linked summary that survives restart", async () => {
  const git = new GitService();
  const h = transitionHarness({
    io: {
      applyPatch: (request) => git.applyPatch(request),
      migrate: async () => ({ status: "refused", reason: "unused" }),
    },
  });
  await repository(h.home);
  const parent = await h.create();
  const fork = await h.fork(parent);
  const answer = Object.values(h.store.snapshotThread(fork).items).find(
    (item) => item.type === "message" && item.role === "assistant" && item.complete,
  );
  if (!answer) throw new Error("No fork answer");
  const server = await startServer({
    store: h.store,
    engine: h.engine,
    handler: h.engine.handler,
    port: 0,
    hostId: "host",
    token,
  });
  const client = await connect(server.url);
  try {
    client.send({
      type: "subscribe",
      subscriptionId: "parent",
      scope: { kind: "thread", threadId: parent },
    });
    await until(client, (message) => message.type === "snapshot");
    const payload = {
      type: "thread.merge" as const,
      threadId: fork,
      summary: "Use the improved implementation",
      citations: [{ threadId: fork, itemId: answer.id }],
      patch:
        "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-Synthetic\n+Improved\n",
    };
    expect(await command(client, "merge-patch", payload)).toMatchObject({ ok: true });
    await h.engine.flush();
    const received = await until(
      client,
      (message) =>
        message.type === "events" &&
        message.events.some(
          (event) =>
            event.payload.type === "item.created" &&
            event.payload.item.type === "message" &&
            event.payload.item.mergedContext?.sourceThreadId === fork,
        ),
    );
    expect(received.type).toBe("events");
    expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("Improved\n");
    expect(await command(client, "merge-patch", payload)).toMatchObject({ ok: true });
    await h.engine.flush();
    await client.close();
    await server.close();
    await h.reopen();
    const messages = Object.values(h.store.snapshotThread(parent).items).filter(
      (item) => item.type === "message" && item.mergedContext,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        mergedContext: {
          sourceThreadId: fork,
          summary: payload.summary,
          citations: payload.citations,
          patchApplied: true,
        },
      }),
    ]);
    expect(await readFile(join(h.home, "file.txt"), "utf8")).toBe("Improved\n");
    expect(h.store.getThread(ThreadId.parse(fork))?.lineage?.parentThreadId).toBe(parent);
  } finally {
    await client.close();
    await server.close();
    await git.close();
    await h.close();
  }
});
