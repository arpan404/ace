import { expect, test } from "vitest";
import { setup } from "./publication-project-test-support.ts";
import { configure, commit } from "./publication-safety-test-support.ts";

const config = (user: string) =>
  `apiVersion: v1\nkind: Config\nusers:\n- name: fixture\n  user:\n${user}\n`;
const samples = [
  {
    label: "quoted Docker registry auth",
    path: "deploy/settings.yaml",
    text: "auths:\n  registry.example.invalid:\n    'auth': c3ludGhldGljOmNyZWRlbnRpYWw=\n",
    deleted: false,
  },
  {
    label: "quoted Docker registry auth",
    path: "deploy/settings.yaml",
    text: "auths:\n  registry.example.invalid:\n    'auth': c3ludGhldGljOmNyZWRlbnRpYWw=\n",
    deleted: true,
  },
  {
    label: "quoted private key",
    path: "deploy/settings.yaml",
    text: "'private_key': 'opaque-value'\n",
    deleted: false,
  },
  {
    label: "quoted private key",
    path: "deploy/settings.yaml",
    text: "'private_key': 'opaque-value'\n",
    deleted: true,
  },
  {
    label: "single-quoted token in kubeconfig",
    path: "deploy/kubeconfig.yaml",
    text: config("    'token': opaque-value"),
    deleted: false,
  },
  {
    label: "single-quoted token in renamed kubeconfig",
    path: "deploy/KUBECONFIG.production.yml",
    text: config("    'token': opaque-value"),
    deleted: true,
  },
  {
    label: "single-quoted token",
    path: "deploy/cluster.yaml",
    text: config("    'token': opaque-value"),
    deleted: false,
  },
  {
    label: "double-quoted token",
    path: "deploy/cluster.yaml",
    text: config('    "token": opaque-value'),
    deleted: true,
  },
  {
    label: "unquoted token",
    path: "deploy/cluster.yaml",
    text: config("    token: opaque-value"),
    deleted: true,
  },
  {
    label: "escaped token key",
    path: "deploy/cluster.yaml",
    text: config('    "t\\u006fken": opaque-value'),
    deleted: true,
  },
  {
    label: "client key data",
    path: "deploy/cluster.yaml",
    text: config("    'client-key-data': b3BhcXVlLXZhbHVl"),
    deleted: false,
  },
  {
    label: "client certificate data",
    path: "deploy/cluster.yaml",
    text: config("    'client-certificate-data': b3BhcXVlLXZhbHVl"),
    deleted: true,
  },
  {
    label: "quoted password",
    path: "deploy/cluster.yaml",
    text: config("    'password': opaque-value"),
    deleted: true,
  },
  {
    label: "auth-provider configuration",
    path: "deploy/cluster.yaml",
    text: config(
      "    'auth-provider':\n      name: opaque-provider\n      config:\n        cached: opaque-value",
    ),
    deleted: false,
  },
  {
    label: "exec environment",
    path: "deploy/cluster.yaml",
    text: config(
      "    'exec':\n      command: credential-helper\n      'env':\n      - name: OPAQUE_AUTH\n        value: opaque-value",
    ),
    deleted: true,
  },
];
for (const sample of samples) {
  test(`publication blocks ${sample.deleted ? "deleted" : "current"} ${sample.path} with ${sample.label} without uploading or rewriting history`, async () => {
    const f = await setup();
    try {
      const remote = await configure(f);
      await commit(f, sample.path, sample.text);
      if (sample.deleted) {
        await f.git(f.path, ["rm", "--", sample.path]);
        await f.git(f.path, ["commit", "-m", "Remove"]);
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

test("a previously scanned blob renamed to YAML in deleted history still receives YAML credential inspection", async () => {
  const f = await setup();
  try {
    const remote = await configure(f);
    await commit(f, "notes.txt", config("    'token': opaque-value"));
    await f.git(f.path, ["mv", "notes.txt", "cluster.yaml"]);
    await f.git(f.path, ["commit", "-m", "Rename"]);
    await f.git(f.path, ["rm", "cluster.yaml"]);
    await f.git(f.path, ["commit", "-m", "Remove"]);
    expect(await f.publish()).toMatchObject({ ok: false, error: "publication_sensitive_history" });
    await expect(f.git(remote, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

for (const sample of [
  { name: "malformed deleted YAML", text: "settings: [broken", deleted: true },
  { name: "an alias", text: "base: &base {value: safe}\ncopy: *base\n", deleted: false },
  { name: "an unknown tag", text: "value: !opaque safe\n", deleted: true },
  { name: "excessive size", text: "#" + "a".repeat(1024 * 1024), deleted: false },
  {
    name: "excessive depth",
    text: Array.from({ length: 66 }, (_, index) => "  ".repeat(index) + "value:\n").join(""),
    deleted: true,
  },
  { name: "excessive nodes", text: "values:\n" + "- safe\n".repeat(100001), deleted: false },
  { name: "excessive documents", text: "---\nvalue: safe\n".repeat(21), deleted: true },
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
