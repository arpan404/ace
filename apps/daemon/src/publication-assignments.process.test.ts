import { expect, test } from "vitest";
import { setup } from "./publication-project-test-support.ts";
import { configure, commit } from "./publication-safety-test-support.ts";

const samples = [
  {
    label: "prefixed environment password",
    path: "config/runtime.conf",
    text: "DB_PASSWORD=opaque-value\n",
  },
  {
    label: "quoted TOML token",
    path: "config/settings.toml",
    text: '[credentials]\n"token" = "opaque-value"\n',
  },
  {
    label: "suffixed password key",
    path: "config/runtime.conf",
    text: "DB_PASSWORD_CURRENT=opaque-value\n",
  },
  {
    label: "single-quoted TOML token",
    path: "config/settings.toml",
    text: "[credentials]\n'APP_TOKEN' = 'opaque-value'\n",
  },
  {
    label: "dotted escaped TOML private key",
    path: "config/settings.toml",
    text: 'service."private\\u005fkey" = "opaque-value"\n',
  },
  {
    label: "registry-scoped npm auth",
    path: "config/runtime.conf",
    text: "//registry.example.invalid/:_auth=opaque-value\n",
  },
];
for (const sample of samples) {
  for (const deleted of [false, true]) {
    test(`publication blocks ${deleted ? "deleted-history" : "current-tree"} ${sample.label} without uploading or changing HEAD`, async () => {
      const f = await setup();
      try {
        const remote = await configure(f);
        await commit(f, sample.path, sample.text);
        if (deleted) {
          await f.git(f.path, ["rm", "--", sample.path]);
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
}

test("ordinary configuration assignments still publish the pinned revision", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "config/runtime.conf", "DB_HOST=example.invalid\nRETRY_COUNT=3\n");
    await commit(f, "config/settings.toml", '[settings]\n"host" = "example.invalid"\n');
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(await f.publish()).toMatchObject({ ok: true, publication: { phase: "pushed" } });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(head);
    expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});
