import { afterEach, expect, test } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { environment, jsonl, claudeRecords, cwd, nativeId, init, text } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test.each(["cold", "changed"])(
  "a %s scan keeps a long sidechain attached when its first prompt is beyond the head sample",
  async (scan) => {
    const env = await environment();
    cleanup.push(env.close);
    const homeDir = join(env.root, "claude");
    const homes = [{ id: "account", provider: "claude" as const, homeDir }];
    const root = join(homeDir, "projects/p", nativeId + ".jsonl");
    const child = join(homeDir, "projects/p", nativeId, "subagents/agent-child.jsonl");
    const childMessages = [
      {
        type: "user",
        sessionId: nativeId,
        isSidechain: true,
        cwd,
        message: { role: "user", content: "child request" },
      },
      {
        type: "assistant",
        sessionId: nativeId,
        isSidechain: true,
        cwd,
        message: { role: "assistant", content: [{ type: "text", text: "child answer" }] },
      },
    ];
    const padding = Array.from({ length: 40 }, () => ({
      type: "system",
      sessionId: nativeId,
      isSidechain: true,
      cwd,
      content: "x".repeat(4096),
    }));
    await jsonl(root, claudeRecords());
    await utimes(root, 1000, 1000);
    const service = await env.start(homes);
    if (scan === "changed") {
      await jsonl(child, childMessages);
      await service.scan();
      expect((await service.list({ type: "history.list", cwd })).sessions).toHaveLength(1);
    }
    await jsonl(child, [...padding, ...childMessages, ...padding]);
    await utimes(child, 2000, 2000);
    await service.scan();
    const assertTree = async (history: typeof service, threadId: string) => {
      const roots = (await history.list({ type: "history.list", cwd })).sessions;
      expect(roots.map((s) => s.nativeId)).toEqual([nativeId]);
      const source = roots[0];
      if (!source) throw new Error("Missing root");
      const request = init(source.id, threadId);
      await history.importSession(request);
      const agents = await history.importedAgents(request.threadId);
      expect(agents).toHaveLength(2);
      const rootAgent = agents.find((a) => a.parentId === null);
      const childAgent = agents.find((a) => a.native.nativeId === "agent-child");
      expect(childAgent?.parentId).toBe(rootAgent?.id);
      expect(
        text((await history.itemsPage({ threadId: request.threadId, limit: 200 })).items),
      ).toContain("child request child answer");
      await history.deleteImported(request.threadId);
    };
    await assertTree(service, "first-import");
    expect(await service.scan()).toMatchObject({ reads: 0, skipped: 2 });
    await service.close();
    const reopened = await env.start(homes);
    await assertTree(reopened, "reopened-import");
  },
);
