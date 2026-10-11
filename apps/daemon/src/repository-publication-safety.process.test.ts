import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { spawnGitProcess } from "@ace/git";
import { input, setup } from "./publication-project-test-support.ts";

type Fixture = Awaited<ReturnType<typeof setup>>;
async function configure(f: Fixture) {
  await f.git(f.path, ["config", "user.name", "Test"]);
  await f.git(f.path, ["config", "user.email", "test@example.invalid"]);
  const remote = join(f.root, "remote.git");
  await mkdir(remote);
  await f.git(remote, ["init", "--bare"]);
  await appendFile(
    join(f.root, "gitconfig"),
    `\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/octo/engine.git\n`,
  );
  return remote;
}
async function commit(f: Fixture, path: string, content: string | Buffer) {
  await mkdir(dirname(join(f.path, path)), { recursive: true });
  await writeFile(join(f.path, path), content);
  await f.git(f.path, ["add", "-f", "--", path]);
  await f.git(f.path, ["commit", "-m", "Fixture"]);
}

test("a restored remote root tree in an intermediate commit is scanned even after HEAD removes it", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, ".env", "synthetic");
    const originalTree = (await f.git(f.path, ["rev-parse", "HEAD^{tree}"])).stdout;
    await f.git(f.path, ["rm", ".env"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    const before = (await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout;
    await commit(f, ".env", "synthetic");
    expect((await f.git(f.path, ["rev-parse", "HEAD^{tree}"])).stdout).toBe(originalTree);
    await f.git(f.path, ["rm", ".env"]);
    await f.git(f.path, ["commit", "-m", "Remove again"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout).toBe(before);
  } finally {
    await f.cleanup();
  }
});
for (const sample of [
  { path: ".env.production", text: "setting=value", deleted: true },
  { path: "config/credentials.json", text: "{}", deleted: false },
  {
    path: "notes.txt",
    text: "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----",
    deleted: true,
  },
  { path: "src/config.txt", text: "ghp_" + "x".repeat(32), deleted: true },
  { path: "archive.bin", text: "\0Bearer synthetic-private-value\0", deleted: false },
  { path: "docs/link.txt", text: "https://example.invalid/#ticket=opaque-credential", deleted: false },
  { path: "docs/link.txt", text: "https://example.invalid/#ticket=opaque-credential", deleted: true },
  {
    path: ".docker/config.json",
    text: JSON.stringify({
      auths: { "registry.example.invalid": { auth: "c3ludGhldGljOmNyZWRlbnRpYWw=" } },
    }),
    deleted: false,
  },
  {
    path: ".docker/config.json",
    text: JSON.stringify({
      auths: { "registry.example.invalid": { auth: "c3ludGhldGljOmNyZWRlbnRpYWw=" } },
    }),
    deleted: true,
  },
  {
    path: "registry.json",
    text: '{"auths":{"registry.example.invalid":{"a\\u0075th":"c3ludGhldGljOmNyZWRlbnRpYWw="}}}',
    deleted: true,
  },
  { path: ".npmrc", text: "//registry.example.invalid/:_authToken=synthetic", deleted: true },
  {
    path: "copied-config.txt",
    text: "//registry.example.invalid/:_authToken=synthetic",
    deleted: true,
  },
  { path: ".pypirc", text: "[index-server]\npassword = synthetic", deleted: true },
  {
    path: ".netrc",
    text: "machine example.invalid login synthetic password synthetic",
    deleted: true,
  },
  { path: ".git-credentials", text: "https://synthetic:synthetic@example.invalid", deleted: true },
  { path: ".aws/credentials", text: "[default]\naws_secret_access_key=synthetic", deleted: true },
  { path: ".azure/msal_token_cache.bin", text: "synthetic", deleted: true },
  { path: ".config/gcloud/access_tokens.db", text: "synthetic", deleted: true },
  {
    path: "copied-cloud.json",
    text: JSON.stringify({ profile: { aws_access_key_id: "synthetic" } }),
    deleted: true,
  },
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
      expect(
        await f.command({
          type: "workspace.publish",
          workspaceId: f.id,
          input: { ...input, visibility: "public" },
        }),
      ).toMatchObject({ ok: false, error: "publication_sensitive_history" });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
    } finally {
      await f.cleanup();
    }
  });
}

test("a sensitive rename of an already-remote safe blob is blocked after the renamed file is deleted", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "note.txt", "safe content");
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    expect(await f.publish()).toMatchObject({ ok: true, publication: { phase: "pushed" } });
    const remoteHead = (await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout;
    await f.git(f.path, ["mv", "note.txt", ".env.reused"]);
    await f.git(f.path, ["commit", "-m", "Rename"]);
    await f.git(f.path, ["rm", ".env.reused"]);
    await f.git(f.path, ["commit", "-m", "Remove"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "refs/heads/trunk"])).stdout).toBe(remoteHead);
  } finally {
    await f.cleanup();
  }
});

test("publication fails closed for an object too large to scan", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "large.bin", Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("publication cannot upload unscanned tag messages through automatic tag following", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "readme", "safe");
    await f.git(f.path, ["config", "push.followTags", "true"]);
    await f.git(f.path, ["tag", "-a", "secret-tag", "-m", "ghp_" + "x".repeat(32)]);
    expect(await f.publish()).toMatchObject({ ok: true, publication: { phase: "pushed" } });
    await expect(
      f.git(remote, ["rev-parse", "--verify", "refs/tags/secret-tag"]),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("sensitive paths in an already-remote subtree are still blocked when reused in new history", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "old/.env", "synthetic");
    const old = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout.trim();
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    await f.git(f.path, ["rm", "old/.env"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    const before = (await f.git(remote, ["rev-parse", "HEAD"])).stdout;
    await f.git(f.path, ["checkout", old, "--", "old"]);
    await f.git(f.path, ["mv", "old", "reused"]);
    await f.git(f.path, ["commit", "-m", "Reuse subtree"]);
    await f.git(f.path, ["rm", "reused/.env"]);
    await f.git(f.path, ["commit", "-m", "Remove again"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test("secret content in an already-remote blob is blocked when reused and deleted in new history", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "old.txt", "ghp_" + "x".repeat(32));
    const old = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout.trim();
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    await f.git(f.path, ["rm", "old.txt"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    const before = (await f.git(remote, ["rev-parse", "HEAD"])).stdout;
    await f.git(f.path, ["checkout", old, "--", "old.txt"]);
    await f.git(f.path, ["mv", "old.txt", "reused.txt"]);
    await f.git(f.path, ["commit", "-m", "Reuse blob"]);
    await f.git(f.path, ["rm", "reused.txt"]);
    await f.git(f.path, ["commit", "-m", "Remove again"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test("publication blocks sensitive history already present on an unchanged remote", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, ".env", "synthetic");
    await f.git(f.path, ["rm", ".env"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    const before = (await f.git(remote, ["rev-parse", "HEAD"])).stdout;
    await commit(f, "readme", "safe");
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(before);
  } finally {
    await f.cleanup();
  }
});

test("a remote branch disappearing before push cannot exclude sensitive history from publication review", async () => {
  let remote: string | undefined;
  const f = await setup(
    {},
    {
      git: {
        processRuntime: {
          spawn(command, args, options) {
            if (args.includes("rev-list") && remote)
              execFileSync("git", ["--git-dir", remote, "update-ref", "-d", "refs/heads/trunk"]);
            return spawnGitProcess(command, args, options);
          },
        },
      },
    },
  );
  try {
    remote = await configure(f);
    await commit(f, ".env", "synthetic");
    await f.git(f.path, ["rm", ".env"]);
    await f.git(f.path, ["commit", "-m", "Clean"]);
    await f.git(f.path, ["push", `file://${remote}`, "HEAD:refs/heads/trunk"]);
    await commit(f, "readme", "safe");
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    await expect(f.git(remote, ["rev-parse", "--verify", "refs/heads/trunk"])).rejects.toThrow();
    expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});
