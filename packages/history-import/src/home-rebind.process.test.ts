import { afterEach, expect, test } from "vitest";
import { join } from "node:path";
import { environment, jsonl, claudeRecords, cwd, nativeId, otherId, init } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test.each(["ancestor", "descendant", "disjoint"])(
  "cached sources from a rebound %s home cannot be listed, imported or continued",
  async (binding) => {
    const env = await environment();
    cleanup.push(env.close);
    const parent = join(env.root, "parent");
    const originalHome = join(parent, "original");
    const homeDir =
      binding === "ancestor"
        ? parent
        : binding === "descendant"
          ? join(originalHome, "nested")
          : join(env.root, "disjoint");
    await jsonl(join(originalHome, "projects/p", nativeId + ".jsonl"), claudeRecords());
    const original = await env.start([
      { id: "account", provider: "claude", homeDir: originalHome },
    ]);
    await original.scan();
    const source = (await original.list({ type: "history.list", cwd })).sessions[0];
    if (!source) throw new Error("Missing original source");
    await original.close();

    const reopened = await env.start([{ id: "account", provider: "claude", homeDir }]);
    const assertRejected = async () => {
      expect((await reopened.list({ type: "history.list", cwd })).sessions).toEqual([]);
      expect(await reopened.get(source.id)).toBeNull();
      await expect(reopened.importSession(init(source.id))).rejects.toThrow(
        "Unknown history source",
      );
      await expect(reopened.continuation(source.id, "resume")).rejects.toThrow(
        "cannot be continued",
      );
    };
    await assertRejected();
    await expect(reopened.scan(AbortSignal.abort())).rejects.toThrow();
    await assertRejected();

    await jsonl(
      join(homeDir, "projects/new", otherId + ".jsonl"),
      claudeRecords("new home", otherId),
    );
    await reopened.scan();
    expect(
      (await reopened.list({ type: "history.list", cwd })).sessions.map((s) => s.nativeId),
    ).toEqual([otherId]);
  },
);

test("an unchanged home serves cached sources before scanning and reuses fingerprints", async () => {
  const env = await environment();
  cleanup.push(env.close);
  const homeDir = join(env.root, "home");
  const homes = [{ id: "account", provider: "claude" as const, homeDir }];
  await jsonl(join(homeDir, "projects/p", nativeId + ".jsonl"), claudeRecords());
  const original = await env.start(homes);
  await original.scan();
  const source = (await original.list({ type: "history.list", cwd })).sessions[0];
  if (!source) throw new Error("Missing original source");
  await original.close();
  const reopened = await env.start(homes);
  expect((await reopened.list({ type: "history.list", cwd })).sessions.map((s) => s.id)).toEqual([
    source.id,
  ]);
  expect(await reopened.get(source.id)).toEqual(source);
  expect(await reopened.scan()).toMatchObject({ reads: 0, skipped: 1 });
});
