import { afterEach, expect, test } from "vitest";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("an older catalog rescans cached sidechain identities before serving them", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const homeDir = join(env.root, "claude");
  const homes = [{ id: "account", provider: "claude" as const, homeDir }];
  await jsonl(join(homeDir, "projects/p", nativeId + ".jsonl"), claudeRecords());
  await jsonl(
    join(homeDir, "projects/p", nativeId, "subagents/agent-child.jsonl"),
    claudeRecords("child request"),
  );
  const original = await env.start(homes);
  await original.scan();
  await original.close();
  // Model a persisted catalog from the version that lost path-derived identity.
  const legacy = new DatabaseSync(join(env.root, "ace/index.sqlite"));
  try {
    legacy.prepare("UPDATE catalog_settings SET value='4' WHERE key='format'").run();
    legacy
      .prepare(
        "UPDATE sources SET id='legacy-child',native=?,parent='sidechain',summary=json_set(summary,'$.id','legacy-child','$.nativeId',?,'$.parentNativeId','sidechain') WHERE parent IS NOT NULL",
      )
      .run(nativeId, nativeId);
  } finally {
    legacy.close();
  }
  const reopened = await env.start(homes);
  expect((await reopened.list({ type: "history.list", cwd })).sessions).toEqual([]);
  expect(await reopened.scan()).toMatchObject({ reads: 2, skipped: 0 });
  const roots = (await reopened.list({ type: "history.list", cwd })).sessions;
  expect(roots.map((s) => s.nativeId)).toEqual([nativeId]);
  const source = roots[0];
  if (!source) throw new Error("Missing root after upgrade");
  const request = init(source.id);
  await reopened.importSession(request);
  expect((await reopened.importedAgents(request.threadId)).map((a) => a.native.nativeId)).toEqual([
    nativeId,
    "agent-child",
  ]);
  expect(text((await reopened.itemsPage({ threadId: request.threadId })).items)).toContain(
    "child request",
  );
});
