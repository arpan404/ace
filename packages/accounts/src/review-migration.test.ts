import { afterEach, expect, test } from "vitest";
import { join, basename, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { migrateSession } from "./index.ts";
import { homes, ids, idle, rollout, put, hash, cleanup } from "./test-support.ts";
afterEach(cleanup);
test.each(["compressed", "malformed", "duplicate"])(
  "unrelated %s rollouts do not disable healthy lineage migration",
  async (kind) => {
    const request = await homes("codex");
    const root = await rollout(request.from.homeDir, 3);
    const other = await rollout(request.from.homeDir, 0);
    await put(
      join(
        request.from.homeDir,
        "archived_sessions",
        basename(other) + (kind === "compressed" ? ".zst" : ""),
      ),
      kind === "duplicate" ? await readFile(other, "utf8") : "bad",
    );
    const before = await hash(root);
    expect(await migrateSession(request, idle)).toMatchObject({
      status: "migrated",
      copiedFiles: 1,
    });
    expect(await hash(root)).toBe(before);
    expect(await hash(join(request.to.homeDir, relative(request.from.homeDir, root)))).toBe(before);
  },
);
test("destination ancestor writer locks refuse migration", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 0);
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[0] });
  await put(join(request.to.homeDir, "thread-writer-locks", `${ids[0]}.lock`), "locked");
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "refused",
    reason: "Session writer lock exists; stop the CLI before migrating",
  });
  expect(await readdir(request.to.homeDir)).toEqual(["thread-writer-locks"]);
});
test("provider mismatch refuses even when a matching physical transcript exists", async () => {
  const request = await homes("claude");
  await put(join(request.from.homeDir, "projects", "-work", `${ids[3]}.jsonl`), "history");
  expect(
    await migrateSession(
      {
        ...request,
        from: { ...request.from, provider: "codex", env: { CODEX_HOME: request.from.homeDir } },
      },
      idle,
    ),
  ).toMatchObject({ status: "refused", reason: "Invalid instance pair" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
});
test("invalid native IDs refuse before touching existing native transcripts", async () => {
  const request = await homes("claude");
  const source = await put(
    join(request.from.homeDir, "projects", "-work", "opaque.jsonl"),
    "history",
  );
  expect(await migrateSession({ ...request, nativeSessionId: "opaque" }, idle)).toMatchObject({
    status: "refused",
  });
  expect(await readdir(request.to.homeDir)).toEqual([]);
  expect(await readFile(source, "utf8")).toBe("history");
});
test("lease cleanup failures preserve the published result and report cleanup separately", async () => {
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const result = await migrateSession(request, {
    acquire: async () => ({
      release: async () => {
        throw new Error("cleanup failed");
      },
    }),
  });
  expect(result).toMatchObject({ status: "migrated", cleanupWarnings: ["lease_release_failed"] });
  expect(await hash(join(request.to.homeDir, relative(request.from.homeDir, source)))).toBe(
    await hash(source),
  );
});
test("source changes during streaming refuse before publication", async () => {
  const { appendFile } = await import("node:fs/promises");
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  let changed = false;
  const result = await migrateSession(request, idle, async (event) => {
    if (event.phase === "copying" && !changed) {
      changed = true;
      await appendFile(source, "changed\n");
    }
  });
  expect(result).toMatchObject({ status: "refused", reason: "Source changed during copy" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
});
test("replacing a source after staging refuses publication", async () => {
  const { rename } = await import("node:fs/promises");
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const before = await hash(source);
  const result = await migrateSession(request, idle, async (event) => {
    if (event.phase === "staged") {
      const content = await readFile(source, "utf8");
      await rename(source, `${source}.original`);
      await put(source, content);
    }
  });
  expect(result).toMatchObject({ status: "refused", reason: "Source changed during migration" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
  expect(await hash(source)).toBe(before);
});
