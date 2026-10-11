import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { input, setup } from "./publication-project-test-support.ts";

type Fixture = Awaited<ReturnType<typeof setup>>;
async function configure(f: Fixture) {
  await f.git(f.path, ["config", "user.name", "Test"]);
  await f.git(f.path, ["config", "user.email", "test@example.invalid"]);
  const remote = join(f.root, "remote.git");
  await mkdir(remote); await f.git(remote, ["init", "--bare"]);
  await appendFile(join(f.root, "gitconfig"), `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`);
  return remote;
}
async function commit(f: Fixture, path: string, content: string | Buffer) {
  await mkdir(dirname(join(f.path, path)), { recursive: true });
  await writeFile(join(f.path, path), content);
  await f.git(f.path, ["add", "-f", "--", path]);
  await f.git(f.path, ["commit", "-m", "Fixture"]);
}
for (const sample of [
  { path: ".env.production", text: "setting=value", deleted: true },
  { path: "config/credentials.json", text: "{}", deleted: false },
  { path: "notes.txt", text: "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----", deleted: true },
  { path: "src/config.txt", text: "ghp_" + "x".repeat(32), deleted: true },
  { path: "archive.bin", text: "\0Bearer synthetic-private-value\0", deleted: false },
]) {
  test(`publication blocks ${sample.path} ${sample.deleted ? "in deleted, ignored history" : "in tracked content"} without changing history or uploading`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, sample.path, sample.text);
      if (sample.deleted) {
        await f.git(f.path, ["rm", "--", sample.path]);
        await writeFile(join(f.path, ".gitignore"), sample.path + "\n");
        await f.git(f.path, ["add", ".gitignore"]);
        await f.git(f.path, ["commit", "-m", "Remove and ignore"]);
      }
      const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
      expect(await f.command({ type: "workspace.publish", workspaceId: f.id,
        input: { ...input, visibility: "public" },
      })).toMatchObject({ ok: false, error: "publication_sensitive_history" });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
    } finally { await f.cleanup(); }
  });
}

test("already-remote deleted history is excluded but a sensitive rename of an existing blob still blocks", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, ".env", "old synthetic value");
    await f.git(f.path, ["rm", ".env"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    await commit(f, "note.txt", "safe content");
    expect(await f.publish()).toMatchObject({ ok: true, publication: { phase: "pushed" } });
    const remoteHead = (await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout;
    await f.git(f.path, ["mv", "note.txt", ".env.reused"]);
    await f.git(f.path, ["commit", "-m", "Rename"]);
    await f.git(f.path, ["rm", ".env.reused"]);
    await f.git(f.path, ["commit", "-m", "Remove"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout).toBe(remoteHead);
  } finally { await f.cleanup(); }
});

test("publication fails closed for an object too large to scan", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "large.bin", Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  } finally { await f.cleanup(); }
});
