import { expect, test } from "vitest";
import { setup } from "./publication-project-test-support.ts";
import { configure, commit } from "./publication-safety-test-support.ts";

// Every YAML sample is classified in packages/git/src/publication-sensitive.test.ts.
// These tests prove YAML inspection runs on current files, deleted files and renamed blobs.
const config = (user: string) =>
  `apiVersion: v1\nkind: Config\nusers:\n- name: fixture\n  user:\n${user}\n`;

test("publication blocks a current YAML credential without uploading or rewriting history", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "deploy/cluster.yaml", config("    'client-key-data': b3BhcXVlLXZhbHVl"));
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    expect((await f.git(f.path, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});

test("a previously scanned blob renamed to YAML in deleted history still receives YAML inspection", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    // Plain text accepts this; only YAML inspection refuses it, so the rename must be followed.
    await commit(f, "notes.txt", "settings: [broken");
    await f.git(f.path, ["mv", "notes.txt", "cluster.yaml"]);
    await f.git(f.path, ["commit", "-m", "Rename"]);
    await f.git(f.path, ["rm", "cluster.yaml"]);
    await f.git(f.path, ["commit", "-m", "Remove"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

for (const sample of [
  {
    name: "an alias in current YAML",
    text: "base: &base {value: safe}\ncopy: *base\n",
    deleted: false,
  },
  { name: "an unknown tag in deleted YAML", text: "value: !opaque safe\n", deleted: true },
]) {
  test(`publication fails closed for ${sample.name}`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, "deploy/settings.yaml", sample.text);
      if (sample.deleted) {
        await f.git(f.path, ["rm", "deploy/settings.yaml"]);
        await f.git(f.path, ["commit", "-m", "Remove"]);
      }
      expect(await f.publish()).toMatchObject({ ok: false, error: "publication_scan_incomplete" });
      await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
}

test("inspectable YAML without credential fields can publish its pinned revision", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(
      f,
      "deploy/settings.yaml",
      "apiVersion: v1\nkind: Config\ncontexts: []\nusers: []\n",
    );
    const head = (await f.git(f.path, ["rev-parse", "HEAD"])).stdout;
    expect(await f.publish()).toMatchObject({ ok: true, publication: { phase: "pushed" } });
    expect((await f.git(remote, ["rev-parse", "HEAD"])).stdout).toBe(head);
  } finally {
    await f.cleanup();
  }
});
