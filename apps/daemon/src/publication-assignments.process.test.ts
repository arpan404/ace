import { expect, test } from "vitest";
import { input, setup } from "./publication-project-test-support.ts";
import { configure, commit } from "./publication-safety-test-support.ts";

// Every credential sample is classified in packages/git/src/publication-sensitive.test.ts.
// These tests prove the classifier is wired into a real publication, current and deleted.
for (const deleted of [false, true]) {
  test(`publication blocks a ${deleted ? "deleted-history" : "current-tree"} credential assignment without uploading or changing HEAD`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, "config/runtime.conf", "DB_PASSWORD=opaque-value\n");
      if (deleted) {
        await f.git(f.path, ["rm", "--", "config/runtime.conf"]);
        await f.git(f.path, ["commit", "-m", "Remove assignment file"]);
      }
      const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
      expect(await f.publish()).toMatchObject({
        ok: false,
        error: "publication_sensitive_history",
      });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
    } finally {
      await f.cleanup();
    }
  });
}

test("ordinary configuration and credential policy settings publish the pinned revision publicly", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "config/runtime.conf", "DB_HOST=example.invalid\nRETRY_COUNT=3\n");
    await commit(
      f,
      "config/settings.toml",
      '[settings]\n"password_min_length" = 8\n"token_url" = "https://example.invalid"\n"token" = ""\n',
    );
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(
      await f.command({
        type: "workspace.publish",
        workspaceId: f.id,
        input: { ...input, visibility: "public" },
      }),
    ).toMatchObject({
      ok: true,
      publication: { phase: "pushed", remote: { visibility: "public" } },
    });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});

test("publication stops at the scan budget without uploading or changing HEAD", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "config/runtime.conf", "a".repeat(16385));
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});
