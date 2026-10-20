import { afterEach, expect, test } from "vitest";
import { readdir, readFile, symlink, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { migrateSession, noMigrationLease } from "./index.ts";
import { ids, idle, homes, rollout, hash, put, cleanup } from "./test-support.ts";
afterEach(cleanup);

test("Codex migration copies the complete depth-three fork lineage without changing source bytes", async () => {
  const request = await homes("codex");
  const sourceFiles: string[] = [];
  for (let index = 0; index < 4; index++)
    sourceFiles.push(
      await rollout(request.from.homeDir, index, index ? { forked_from_id: ids[index - 1] } : {}),
    );
  const before = await Promise.all(sourceFiles.map(hash));
  expect(await migrateSession(request, idle)).toEqual({
    status: "migrated",
    nativeSessionId: request.nativeSessionId,
    action: "fork",
    copiedFiles: 4,
  });
  expect(await Promise.all(sourceFiles.map(hash))).toEqual(before);
  expect(
    await Promise.all(
      sourceFiles.map((file) =>
        hash(join(request.to.homeDir, relative(request.from.homeDir, file))),
      ),
    ),
  ).toEqual(before);
  expect(await readdir(request.to.homeDir)).toEqual(["sessions"]);
});
test("Codex also copies session metadata root and parent-thread references", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 0);
  await rollout(request.from.homeDir, 1);
  await rollout(request.from.homeDir, 3, { session_id: ids[0], parent_thread_id: ids[1] });
  expect(await migrateSession(request, idle)).toMatchObject({ status: "migrated", copiedFiles: 3 });
});
test("a missing fork parent hands over and a cyclic lineage refuses, before publishing any files", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[2] });
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "unsupported",
    reason: "Missing session or ancestor rollout",
  });
  expect(await readdir(request.to.homeDir)).toEqual([]);
  await rollout(request.from.homeDir, 2, { forked_from_id: ids[3] });
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "refused",
    reason: "Cyclic session lineage",
  });
});
test("a spawning thread that is gone doesn't stop the copy of a session it started", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3, { parent_thread_id: ids[1] });
  expect(await migrateSession(request, idle)).toMatchObject({ status: "migrated", copiedFiles: 1 });
});
test("a paginated fork copies with the base it reads through and no account-wide database", async () => {
  const request = await homes("codex");
  const base = await rollout(request.from.homeDir, 0, { history_mode: "paginated" });
  const fork = await rollout(request.from.homeDir, 3, {
    history_mode: "paginated",
    history_base: { thread_id: ids[0], end_ordinal_exclusive: 2, end_byte_offset: 400 },
  });
  await put(join(request.from.homeDir, "state_5.sqlite"), "account-wide index");
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "migrated",
    action: "fork",
    copiedFiles: 2,
  });
  for (const file of [base, fork])
    expect(await hash(join(request.to.homeDir, relative(request.from.homeDir, file)))).toBe(
      await hash(file),
    );
  expect(await readdir(request.to.homeDir)).toEqual(["sessions"]);
});
test("a Codex lock file left by a writer that exited doesn't block a copy the lease holds", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 0);
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[0] });
  const lock = await put(
    join(request.from.homeDir, "thread-writer-locks", `${ids[3]}.lock`),
    "stale",
  );
  expect(await migrateSession(request, idle)).toMatchObject({ status: "migrated", copiedFiles: 2 });
  expect(await readFile(lock, "utf8")).toBe("stale");
});
test("a session another process has open is refused with nothing copied and the lease untouched", async () => {
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const before = await hash(source);
  expect(
    await migrateSession(request, {
      acquire: async () => ({ status: "busy", reason: "Another Codex process has it open" }),
    }),
  ).toEqual({ status: "refused", reason: "Another Codex process has it open" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
  expect(await hash(source)).toBe(before);
});
test("a provider without a lease reports unsupported, so the thread hands over", async () => {
  const request = await homes("claude");
  await put(join(request.from.homeDir, "projects", "-work", `${ids[3]}.jsonl`), "synthetic\n");
  expect(await migrateSession(request, noMigrationLease)).toMatchObject({ status: "unsupported" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
});
test("Claude preserves the root JSONL and every subagent sidechain and metadata file", async () => {
  const request = await homes("claude");
  const project = join(request.from.homeDir, "projects", "-Users-test-Code");
  const files = [
    await put(join(project, `${ids[3]}.jsonl`), '{"type":"user","message":"history"}\n'),
    await put(join(project, ids[3] ?? "", "subagents", "agent-a.jsonl"), "child-history\n"),
    await put(
      join(project, ids[3] ?? "", "subagents", "agent-a.meta.json"),
      '{"agentType":"Explore"}',
    ),
  ];
  const before = await Promise.all(files.map(hash));
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "migrated",
    action: "resume",
    copiedFiles: 3,
  });
  expect(await Promise.all(files.map(hash))).toEqual(before);
  expect(
    await Promise.all(
      files.map((file) => hash(join(request.to.homeDir, relative(request.from.homeDir, file)))),
    ),
  ).toEqual(before);
});
test("a different session already under the ID in the destination hands over, leaving both copies and releasing the lease", async () => {
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const target = await put(
    join(request.to.homeDir, relative(request.from.homeDir, source)),
    "existing destination",
  );
  const sourceBefore = await hash(source);
  let released = false;
  const result = await migrateSession(request, {
    acquire: async () => ({
      status: "held",
      release: async () => {
        released = true;
      },
    }),
  });
  expect(result).toMatchObject({
    status: "unsupported",
    reason: "Destination session already exists",
  });
  expect(await readFile(target, "utf8")).toBe("existing destination");
  await expect(hash(source)).resolves.toBe(sourceBefore);
  expect(released).toBe(true);
});
test("symlinked sidechains and destination directories are refused", async () => {
  const request = await homes("claude");
  const root = await put(
    join(request.from.homeDir, "projects", "-work", `${ids[3]}.jsonl`),
    "history\n",
  );
  const chains = join(request.from.homeDir, "projects", "-work", ids[3] ?? "", "subagents");
  await mkdir(chains, { recursive: true });
  await symlink(root, join(chains, "agent-a.jsonl"));
  expect(await migrateSession(request, idle)).toMatchObject({ status: "refused" });
  const codex = await homes("codex");
  await rollout(codex.from.homeDir, 3);
  await symlink(codex.from.homeDir, join(codex.to.homeDir, "sessions"));
  expect(await migrateSession(codex, idle)).toMatchObject({ status: "refused" });
  expect((await readdir(codex.to.homeDir)).filter((name) => name.startsWith(".ace"))).toEqual([]);
});
test("unsupported providers return a reason and invalid IDs never reach filesystem planning", async () => {
  for (const provider of ["cursor", "opencode", "pi"] as const)
    expect(await migrateSession(await homes(provider), idle)).toMatchObject({
      status: "unsupported",
    });
  const request = await homes("codex");
  expect(
    await migrateSession({ ...request, nativeSessionId: "../../auth.json" }, idle),
  ).toMatchObject({ status: "refused" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
});

test("late publication failure removes ancestors already published and leaves the source unchanged", async () => {
  const { rename } = await import("node:fs/promises");
  const request = await homes("codex");
  const parent = await rollout(request.from.homeDir, 0);
  const archive = join(request.from.homeDir, "archived_sessions", parent.split("/").at(-1) ?? "");
  await mkdir(join(request.from.homeDir, "archived_sessions"));
  await rename(parent, archive);
  const root = await rollout(request.from.homeDir, 3, { forked_from_id: ids[0] });
  const before = await hash(root);
  await symlink(request.from.homeDir, join(request.to.homeDir, "sessions"));
  expect(await migrateSession(request, idle)).toMatchObject({ status: "refused" });
  expect(await readdir(join(request.to.homeDir, "archived_sessions"))).toEqual([]);
  expect(await hash(root)).toBe(before);
});
test("a self-referencing fork is refused and opaque unsupported-provider IDs still report unsupported", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[3] });
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "refused",
    reason: "Cyclic session lineage",
  });
  const open = await homes("opencode");
  expect(await migrateSession({ ...open, nativeSessionId: "ses_native" }, idle)).toMatchObject({
    status: "unsupported",
  });
});

test("sibling forks reuse byte-identical migrated ancestors and repeated migration is idempotent", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 0);
  await rollout(request.from.homeDir, 2, { forked_from_id: ids[0] });
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[0] });
  expect(await migrateSession({ ...request, nativeSessionId: ids[2] ?? "" }, idle)).toMatchObject({
    status: "migrated",
    copiedFiles: 2,
  });
  expect(await migrateSession(request, idle)).toMatchObject({ status: "migrated", copiedFiles: 1 });
  expect(await migrateSession(request, idle)).toMatchObject({ status: "migrated", copiedFiles: 0 });
});

test("overlapping destinations and aliases are refused before creating anything in the source home", async () => {
  const { createInstance } = await import("./index.ts");
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3);
  const before = await readdir(request.from.homeDir);
  const nested = createInstance({ ...request.to, homeDir: join(request.from.homeDir, "nested") });
  expect(await migrateSession({ ...request, to: nested }, idle)).toMatchObject({
    status: "refused",
    reason: "Instance homes overlap",
  });
  expect(await readdir(request.from.homeDir)).toEqual(before);
  const alias = join(request.to.homeDir, "alias");
  await symlink(request.from.homeDir, alias);
  const viaAlias = createInstance({ ...request.to, homeDir: join(alias, "nested") });
  expect(await migrateSession({ ...request, to: viaAlias }, idle)).toMatchObject({
    status: "refused",
    reason: "Instance homes overlap",
  });
  expect(await readdir(request.from.homeDir)).toEqual(before);
});
