import { afterEach, expect, test } from "vitest";
import { readdir, readFile, symlink, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { migrateSession } from "./index.ts";
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
test("missing ancestors and cyclic lineage refuse before publishing any files", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[2] });
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "refused",
    reason: "Missing session or ancestor rollout",
  });
  expect(await readdir(request.to.homeDir)).toEqual([]);
  await rollout(request.from.homeDir, 2, { forked_from_id: ids[3] });
  expect(await migrateSession(request, idle)).toMatchObject({
    status: "refused",
    reason: "Cyclic session lineage",
  });
});
test("paginated history is reported unsupported without copying account-wide databases", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 3, {
    history_mode: "paginated",
    history_base: { thread_id: ids[0] },
  });
  await put(join(request.from.homeDir, "thread_history_1.sqlite"), "not safe to copy");
  expect(await migrateSession(request, idle)).toMatchObject({ status: "unsupported" });
  expect(await readdir(request.to.homeDir)).toEqual([]);
});
test("a writer lock on any ancestor refuses migration and is left unchanged", async () => {
  const request = await homes("codex");
  await rollout(request.from.homeDir, 0);
  await rollout(request.from.homeDir, 3, { forked_from_id: ids[0] });
  const lock = await put(
    join(request.from.homeDir, "thread-writer-locks", `${ids[0]}.lock`),
    "live-or-stale",
  );
  expect(await migrateSession(request, idle)).toMatchObject({ status: "refused" });
  expect(await readFile(lock, "utf8")).toBe("live-or-stale");
  expect(await readdir(request.to.homeDir)).toEqual([]);
});
test("a real live process prevents acquiring quiescence even without a writer lock", async () => {
  const request = await homes("claude");
  await put(join(request.from.homeDir, "projects", "-work", `${ids[3]}.jsonl`), "synthetic\n");
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready');process.stdin.resume()"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout, "data");
    const pid = child.pid;
    const result = await migrateSession(request, {
      acquire: async () => {
        if (pid !== undefined) {
          try {
            process.kill(pid, 0);
            return undefined;
          } catch {}
        }
        return { release: async () => {} };
      },
    });
    expect(result).toMatchObject({
      status: "refused",
      reason: "Source or destination is live, or exclusive quiescence cannot be proven",
    });
    expect(await readdir(request.to.homeDir)).toEqual([]);
  } finally {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
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
test("destination collisions leave both copies unchanged and release the lease", async () => {
  const request = await homes("codex");
  const source = await rollout(request.from.homeDir, 3);
  const target = await put(
    join(request.to.homeDir, relative(request.from.homeDir, source)),
    "existing destination",
  );
  let released = false;
  const result = await migrateSession(request, {
    acquire: async () => ({
      release: async () => {
        released = true;
      },
    }),
  });
  expect(result).toMatchObject({ status: "refused", reason: "Destination session already exists" });
  expect(await readFile(target, "utf8")).toBe("existing destination");
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
  for (const provider of ["cursor", "opencode"] as const)
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
