import { join } from "node:path";
import { unlink, appendFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { environment, jsonl, claudeRecords, cwd } from "./test-support.ts";

test("a changed transcript and a deletion refresh without dropping unrelated cached sessions", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const first = join(home, "projects/p/first.jsonl"),
    second = join(home, "projects/p/second.jsonl");
  const homes = [{ id: "account", provider: "claude" as const, homeDir: home }];
  try {
    await jsonl(first, claudeRecords("first", "first"));
    await jsonl(second, claudeRecords("second", "second"));
    const service = await env.start(homes);
    await service.scan();
    const changed = Promise.withResolvers<void>();
    const unsubscribe = service.subscribeChanges(() => changed.resolve());
    await appendFile(
      first,
      JSON.stringify({ type: "ai-title", sessionId: "first", aiTitle: "later" }) + "\n",
    );
    await changed.promise;
    unsubscribe();
    const update = await service.scanChanges();
    expect(update.reads).toBe(1);
    const listed = await service.list({ type: "history.list", cwd, limit: 10 });
    expect(listed.sessions.map((session) => session.nativeId).toSorted()).toEqual([
      "first",
      "second",
    ]);
    expect(listed.sessions.find((session) => session.nativeId === "first")?.title).toBe("later");
    const deleted = Promise.withResolvers<void>();
    const stop = service.subscribeChanges(() => deleted.resolve());
    await unlink(first);
    await deleted.promise;
    stop();
    await service.scanChanges();
    expect(
      (await service.list({ type: "history.list", cwd, limit: 10 })).sessions.map(
        (session) => session.nativeId,
      ),
    ).toEqual(["second"]);
    await service.close();
    // No filesystem event was observed while closed. Restart must not trust a directory mtime.
    await appendFile(
      second,
      JSON.stringify({ type: "ai-title", sessionId: "second", aiTitle: "offline" }) + "\n",
    );
    const restarted = await env.start(homes);
    await restarted.scan();
    expect(
      (await restarted.list({ type: "history.list", cwd, limit: 10 })).sessions[0]?.title,
    ).toBe("offline");
  } finally {
    await env.close();
  }
});
