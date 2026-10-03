import { join } from "node:path";
import { unlink, appendFile, writeFile, rename, mkdir } from "node:fs/promises";
import { expect, test } from "vitest";
import { environment, jsonl, claudeRecords, cwd } from "./test-support.ts";
import type { HistoryService } from "./index.ts";

async function observedUpdate(
  service: HistoryService,
  mutate: () => Promise<void>,
  visible: (response: Awaited<ReturnType<HistoryService["list"]>>) => boolean,
) {
  let changed = Promise.withResolvers<void>();
  const stop = service.subscribeChanges(() => changed.resolve());
  try {
    await mutate();
    for (;;) {
      await changed.promise;
      // Earlier startup notifications may arrive alongside the mutation. Keep
      // waiting on real native events until the requested public result is visible.
      changed = Promise.withResolvers<void>();
      const result = await service.scanChanges();
      if (visible(await service.list({ type: "history.list", cwd, limit: 10 }))) return result;
    }
  } finally {
    stop();
  }
}

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
    const update = await observedUpdate(
      service,
      () =>
        appendFile(
          first,
          JSON.stringify({ type: "ai-title", sessionId: "first", aiTitle: "later" }) + "\n",
        ),
      (result) =>
        result.sessions.some(
          (session) => session.nativeId === "first" && session.title === "later",
        ),
    );
    expect(update.reads).toBe(1);
    const listed = await service.list({ type: "history.list", cwd, limit: 10 });
    expect(listed.sessions.map((session) => session.nativeId).toSorted()).toEqual([
      "first",
      "second",
    ]);
    expect(listed.sessions.find((session) => session.nativeId === "first")?.title).toBe("later");
    await observedUpdate(
      service,
      () => unlink(first),
      (result) => !result.sessions.some((session) => session.nativeId === "first"),
    );
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

test("watch overflow falls back to inventory verification without retaining every changed path", async () => {
  const env = await environment();
  const home = join(env.root, "claude");
  const directory = join(home, "projects/p");
  try {
    await jsonl(join(directory, "retained.jsonl"), claudeRecords("retained", "retained"));
    for (let offset = 0; offset < 4100; offset += 64)
      await Promise.all(
        Array.from({ length: Math.min(64, 4100 - offset) }, (_, index) =>
          (async () => {
            const parent = join(directory, `noise-${offset + index}`);
            await mkdir(parent);
            await writeFile(join(parent, "noise.tmp"), "");
          })(),
        ),
      );
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
    await service.scanChanges();
    const overflow = Promise.withResolvers<void>();
    let observed = 0;
    const unsubscribe = service.subscribeChanges(() => {
      // Native notifications provide the ordering boundary, without timing sleeps.
      if (++observed > 4096) overflow.resolve();
    });
    try {
      for (let offset = 0; offset < 4100; offset += 64)
        await Promise.all(
          Array.from({ length: Math.min(64, 4100 - offset) }, (_, index) =>
            appendFile(join(directory, `noise-${offset + index}`, "noise.tmp"), "x"),
          ),
        );
      await overflow.promise;
      // None of the noise files are transcripts. Only a full fallback verifies this
      // unchanged source; an unbounded dirty-path batch would visit zero transcripts.
      expect(await service.scanChanges()).toMatchObject({ files: 1, reads: 0, skipped: 1 });
      expect((await service.list({ type: "history.list", cwd })).sessions[0]?.title).toBe(
        "retained",
      );
    } finally {
      unsubscribe();
    }
  } finally {
    await env.close();
  }
}, 30000);

test("a renamed transcript removes the old source while preserving its native session", async () => {
  const env = await environment();
  const home = join(env.root, "claude"),
    directory = join(home, "projects/p");
  try {
    await jsonl(join(directory, "old.jsonl"), claudeRecords("same", "native"));
    const service = await env.start([{ id: "account", provider: "claude", homeDir: home }]);
    await service.scanChanges();
    const previous = (await service.list({ type: "history.list", cwd })).sessions[0];
    if (!previous) throw new Error("Missing source");
    const observed = Promise.withResolvers<void>();
    const stop = service.subscribeChanges(() => observed.resolve());
    try {
      await rename(join(directory, "old.jsonl"), join(directory, "new.jsonl"));
      await observed.promise;
      await service.scanChanges();
      const sessions = (await service.list({ type: "history.list", cwd })).sessions;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.nativeId).toBe("native");
      expect(await service.get(previous.id)).toBeNull();
    } finally {
      stop();
    }
  } finally {
    await env.close();
  }
});
