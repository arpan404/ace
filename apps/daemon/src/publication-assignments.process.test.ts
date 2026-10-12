import { expect, test } from "vitest";
import { input, setup } from "./publication-project-test-support.ts";
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
  { label: "API token", path: "config/runtime.conf", text: "api_token=opaque-value\n" },
  { label: "opaque auth", path: "config/runtime.conf", text: "auth=opaque-value\n" },
  { label: "opaque private key", path: "config/runtime.conf", text: "private_key=opaque-value\n" },
  {
    label: "password following an unfinished endpoint value",
    path: "config/runtime.conf",
    text: 'token_url = "unfinished\nDB_PASSWORD=opaque-value\n',
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

const ordinary = [
  {
    label: "password policy and token endpoint settings",
    path: "config/runtime.conf",
    text: 'password_min_length = 8\ntoken_url = "https://example.invalid"\n',
  },
  {
    label: "credential location and lifetime settings",
    path: "config/runtime.conf",
    text: 'api_token_endpoint = "https://example.invalid"\nprivate_key_path = "local/key"\npassword_file = "local/pass"\ntoken_expiry = 120\ntoken_ttl = 60\npassword_max_length = 100\npasswordMinLength = 8\n',
  },
  {
    label: "quoted and dotted TOML policy settings",
    path: "config/settings.toml",
    text: '[settings]\n"password_min_length" = 8\n"token_url" = "https://example.invalid"\nauth.token_endpoint = "https://example.invalid"\n',
  },
  {
    label: "many short unfinished dotted expressions",
    path: "config/runtime.conf",
    text: "a . a\n".repeat(10000),
  },
  {
    label: "long non-credential scalar values",
    path: "config/runtime.conf",
    text: 'banner = "' + "a".repeat(20000) + '"\nexample = ' + "a".repeat(20000) + "\n",
  },
];
for (const sample of ordinary) {
  test(`public publication accepts ${sample.label}`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, sample.path, sample.text);
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
}

for (const sample of [
  { label: "long unfinished dotted key", text: "a . ".repeat(50000) },
  { label: "oversized bare key without a separator", text: "a".repeat(16385) },
  { label: "oversized quoted key without a separator", text: '"' + "a".repeat(16385) },
]) {
  test(`publication stops at the scan budget for a ${sample.label}`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, "config/runtime.conf", sample.text);
      const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
      expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
      expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
    } finally {
      await f.cleanup();
    }
  });
}
