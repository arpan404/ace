import { expect, test } from "vitest";
import { Worker } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openHistory } from "./index.ts";
import { environment, jsonl, claudeRecords, codexRecords, cwd, init } from "./test-support.ts";

for (const mode of ["stat", "read"] as const) {
  test(`a transcript appended during ${mode} sampling preserves its row and retries only that path`, async () => {
    const env = await environment();
    const home = join(env.root, "claude"),
      codex = join(env.root, "codex");
    const path = join(home, "projects/p/live.jsonl"),
      marker = join(env.root, "race");
    await jsonl(path, claudeRecords("before", "live"));
    await jsonl(join(home, "projects/p/stable.jsonl"), claudeRecords("stable", "stable"));
    await jsonl(join(codex, "sessions/rollout.jsonl"), codexRecords());
    const service = await openHistory(
      {
        indexPath: join(env.root, "index.sqlite"),
        instances: [
          { id: "claude", provider: "claude", homeDir: home },
          { id: "codex", provider: "codex", homeDir: codex },
        ],
      },
      (url, options) =>
        new Worker(url, {
          ...options,
          execArgv: ["--import", new URL("./sampling-race-preload.ts", import.meta.url).href],
          env: { ...process.env, ACE_TEST_SAMPLE_RACE: JSON.stringify({ path, marker, mode }) },
        }),
      { watch: () => () => {} },
    );
    try {
      await service.scan();
      await jsonl(path, claudeRecords("new input", "live"));
      await writeFile(marker, "armed");
      expect((await service.scan()).unsupported).toEqual([]);
      const sessions = (await service.list({ type: "history.list", cwd })).sessions;
      expect(sessions).toHaveLength(3);
      expect(sessions.find((session) => session.nativeId === "live")?.title).toBe("before");
      expect(await service.scanChanges()).toMatchObject({ files: 1, reads: 1 });
      expect(
        (await service.list({ type: "history.list", cwd })).sessions.find(
          (session) => session.nativeId === "live",
        )?.title,
      ).toBe("after race");
      expect(await service.scanChanges()).toMatchObject({ files: 0, reads: 0 });
    } finally {
      await service.close();
      await env.close();
    }
  });
}

test("transcript sampling yields without holding the index write lock", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  for (let i = 0; i < 64; i++)
    await jsonl(join(home, `projects/p/${i}.jsonl`), claudeRecords("prompt", `s${i}`));
  const indexPath = join(env.root, "index.sqlite");
  const service = await openHistory({
    indexPath,
    instances: [{ id: "account", provider: "claude", homeDir: home }],
  });
  const writer = new DatabaseSync(indexPath);
  let sampled = false;
  try {
    await service.scan(undefined, (files) => {
      if (files !== 64 || sampled) return;
      writer.exec(
        "BEGIN IMMEDIATE; INSERT OR REPLACE INTO catalog_settings VALUES('external-writer','ready'); COMMIT",
      );
      sampled = true;
    });
    expect(sampled).toBe(true);
    expect((await service.list({ type: "history.list", cwd, limit: 100 })).sessions).toHaveLength(
      64,
    );
  } finally {
    writer.close();
    await service.close();
    await env.close();
  }
});

test("a user record above 128 KiB is previewed and can be imported within the native record budget", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  await jsonl(
    join(home, "projects/p/large.jsonl"),
    claudeRecords("Investigate large context " + "x".repeat(300 * 1024), "large"),
  );
  try {
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
    expect((await service.scan()).unsupported).toEqual([]);
    const session = (await service.list({ type: "history.list", cwd })).sessions[0];
    if (!session) throw new Error("Missing saved session");
    expect(session.title).toContain("Investigate large context");
    await expect(service.importSession(init(session.id))).resolves.toMatchObject({
      messageCount: 2,
    });
  } finally {
    await env.close();
  }
});
